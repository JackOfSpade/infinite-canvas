import assert from 'node:assert';
import {
  classifyJobBoardSourceAdmission,
  isJobSearchRunShownOnOtherBoard,
  jobSearchShownRun,
  jobSearchShownRunPatch,
  partitionJobBoardSourceAdmissions,
} from '../../src/utils/jobBoardSourceAdmission.js';
import { buildJobHubRescanCapabilityPatch } from '../../src/utils/jobSearchSplitClear.js';
import { jobSearchRescrapeAvailability, JOB_SOURCE_RESCRAPE_INTERVAL_MS } from '../../src/utils/jobSearchSourceCoverage.js';
import { jobCareerImportBoardAdmission } from '../../src/utils/jobCareerImportCapability.js';
import { approveCareerImportCompilation, beginCareerImportCompilation } from '../../src/utils/jobCareerCompilationReceipt.js';
import { remapCopiedJobModuleReferences } from '../../src/utils/jobBoardSearchSelection.js';
import fs from 'node:fs';

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = JOB_SOURCE_RESCRAPE_INTERVAL_MS;
const SNAPSHOT = 'a'.repeat(64);
const SOURCES = ['linkedin', 'indeed'];
const JOBS = [
  { title: 'Product Manager', company: 'Example', url: 'https://jobs.example.test/pm', matchScore: 88 },
];

function generationFor(id) { return `career-import:${id}:11111111-1111-4111-8111-111111111111`; }

function coverage(ages, ids = SOURCES) {
  const out = {};
  ids.forEach((id, i) => { out[id] = { coverageStartedAt: NOW - ages[i] - HOUR, completedAt: NOW - ages[i] }; });
  return out;
}

function hub(id = 'hub-1', extra = {}) {
  const generation = generationFor(id);
  const begun = beginCareerImportCompilation({ generation, attemptId: 'attempt-1' });
  return {
    id,
    type: 'jobhub',
    data: {
      hubState: 'done',
      jobRunId: 'run-1',
      resultDisposition: 'scored',
      scoredJobs: JOBS,
      inputLocked: true,
      careerSnapshotId: SNAPSHOT,
      careerImportGeneration: generation,
      careerImportCompilation: approveCareerImportCompilation(begun, {
        generation, attemptId: 'attempt-1', careerSnapshotId: SNAPSHOT,
      }),
      enabledSourceIds: SOURCES,
      searchLocation: { mode: 'city', city: 'Toronto', subdivision: 'ON', country: 'CA', value: 'Toronto, ON' },
      sourceCoverage: coverage([2 * DAY, 3 * DAY]),
      ...extra,
    },
  };
}

const shownBy = (boardId, runId = 'run-1') => ({ boardShownRun: { runId, boardId, shownAt: NOW - HOUR } });
const classify = (source, boardId = 'board-1') => classifyJobBoardSourceAdmission(source, { now: NOW, boardId });

export default [
  { name: 'Rescrape admission: an unshown hub with saved jobs and a due platform is reused, never re-scraped', run: () => {
    const admission = classify(hub());
    assert.equal(admission.kind, 'reuse-terminal');
  } },
  { name: 'Rescrape admission: a shown hub with a due platform is rescrape-terminal and names the due platforms', run: () => {
    const admission = classify(hub('hub-1', shownBy('board-1')));
    assert.equal(admission.kind, 'rescrape-terminal');
    assert.deepEqual([...admission.dueSourceIds].sort(), [...SOURCES].sort());
    assert.ok(admission.outcome);
  } },
  { name: 'Rescrape admission: a shown hub whose platforms are all fresh is reused by the same Board', run: () => {
    const source = hub('hub-1', { ...shownBy('board-1'), sourceCoverage: coverage([2 * HOUR, 5 * HOUR]) });
    assert.equal(classify(source, 'board-1').kind, 'reuse-terminal');
  } },
  { name: 'Rescrape admission: a shown hub whose platforms are all fresh cools down for another Board until the earliest platform is due', run: () => {
    const source = hub('hub-1', { ...shownBy('board-1'), sourceCoverage: coverage([2 * HOUR, 5 * HOUR]) });
    const admission = classify(source, 'board-2');
    assert.equal(admission.kind, 'rescrape-cooldown');
    assert.equal(admission.nextEligibleAt, NOW - 5 * HOUR + DAY);
    assert.equal(typeof admission.reason, 'string');
    assert.ok(admission.reason.length > 0);
  } },
  { name: 'Rescrape admission: a shown hub that is due is re-scraped by another Board too', run: () => {
    assert.equal(classify(hub('hub-1', shownBy('board-1')), 'board-2').kind, 'rescrape-terminal');
  } },
  { name: 'Rescrape admission: without a Board id a run shown elsewhere still reads as reusable', run: () => {
    const source = hub('hub-1', { ...shownBy('board-1'), sourceCoverage: coverage([2 * HOUR, 5 * HOUR]) });
    assert.equal(classifyJobBoardSourceAdmission(source, { now: NOW }).kind, 'reuse-terminal');
  } },
  { name: 'Rescrape admission: a mergeable hub with zero saved jobs and a due platform is rescrape-terminal', run: () => {
    const source = hub('hub-1', { scoredJobs: [], resultDisposition: 'empty-complete' });
    assert.equal(classify(source).kind, 'rescrape-terminal');
  } },
  { name: 'Rescrape admission: a mergeable hub with zero saved jobs and fresh platforms is reused', run: () => {
    const source = hub('hub-1', {
      scoredJobs: [], resultDisposition: 'empty-complete', sourceCoverage: coverage([HOUR, HOUR]),
    });
    assert.equal(classify(source).kind, 'reuse-terminal');
  } },
  { name: 'Rescrape admission: a test-mode or collection-only hub is searched again when due and cools down otherwise', run: () => {
    for (const extra of [{ testMode: true }, { collectionOnly: true, resultDisposition: 'collection-only' }]) {
      assert.equal(classify(hub('hub-1', extra)).kind, 'rescrape-terminal', JSON.stringify(extra));
      const cooling = classify(hub('hub-1', { ...extra, sourceCoverage: coverage([HOUR, 3 * HOUR]) }));
      assert.equal(cooling.kind, 'rescrape-cooldown', JSON.stringify(extra));
      assert.equal(cooling.nextEligibleAt, NOW - 3 * HOUR + DAY);
    }
  } },
  { name: 'Rescrape admission: a done hub without a valid career snapshot id requires fresh input', run: () => {
    for (const careerSnapshotId of [undefined, '', 'abc', 'z'.repeat(64)]) {
      const source = hub('hub-1', { ...shownBy('board-1'), testMode: true });
      source.data.careerSnapshotId = careerSnapshotId;
      const admission = classify(source);
      assert.notEqual(admission.kind, 'rescrape-terminal', String(careerSnapshotId));
      assert.notEqual(admission.kind, 'rescrape-cooldown', String(careerSnapshotId));
    }
    // No approved compilation either, so the only terminal fallback is the clear-and-import one.
    const bare = hub('hub-1', { testMode: true });
    delete bare.data.careerSnapshotId;
    delete bare.data.careerImportGeneration;
    delete bare.data.careerImportCompilation;
    const admission = classify(bare);
    assert.equal(admission.kind, 'terminal-requires-fresh-input');
    assert.match(admission.reason, /career data/i);
    assert.match(admission.reason, /import/i);
  } },
  { name: 'Rescrape admission: a recovery in flight blocks a rescrape of a non-mergeable card', run: () => {
    const source = hub('hub-1', { testMode: true, manualAiResume: { runId: 'manual-1' } });
    assert.equal(classify(source).kind, 'terminal-requires-fresh-input');
  } },
  { name: 'Rescrape admission: a stale boardShownRun for an older run is ignored', run: () => {
    const source = hub('hub-1', shownBy('board-1', 'older-run'));
    assert.equal(jobSearchShownRun(source.data), null);
    assert.equal(classify(source, 'board-2').kind, 'reuse-terminal');
    const cooling = hub('hub-1', { ...shownBy('board-1', 'older-run'), sourceCoverage: coverage([HOUR, HOUR]) });
    assert.equal(classify(cooling, 'board-2').kind, 'reuse-terminal');
  } },
  { name: 'Shown run: the patch claims once, refuses a second Board and refuses a mismatched run id', run: () => {
    const data = hub().data;
    const patch = jobSearchShownRunPatch(data, { boardId: 'board-1', runId: 'run-1', now: NOW });
    assert.deepEqual(patch, { boardShownRun: { runId: 'run-1', boardId: 'board-1', shownAt: NOW } });
    const claimed = { ...data, ...patch };
    assert.equal(jobSearchShownRunPatch(claimed, { boardId: 'board-2', runId: 'run-1', now: NOW }), null);
    assert.equal(jobSearchShownRunPatch(claimed, { boardId: 'board-1', runId: 'run-1', now: NOW }), null);
    assert.equal(jobSearchShownRunPatch(data, { boardId: 'board-1', runId: 'other-run', now: NOW }), null);
    assert.equal(jobSearchShownRunPatch(data, { boardId: '', runId: 'run-1', now: NOW }), null);
    // A later run's marker replaces the obsolete one.
    const later = { ...claimed, jobRunId: 'run-2' };
    assert.deepEqual(
      jobSearchShownRunPatch(later, { boardId: 'board-2', runId: 'run-2', now: NOW }),
      { boardShownRun: { runId: 'run-2', boardId: 'board-2', shownAt: NOW } },
    );
  } },
  { name: 'Shown run: isJobSearchRunShownOnOtherBoard compares the claiming Board with the asking one', run: () => {
    const source = hub('hub-1', shownBy('board-1'));
    assert.equal(isJobSearchRunShownOnOtherBoard(source, 'board-1'), false);
    assert.equal(isJobSearchRunShownOnOtherBoard(source, 'board-2'), true);
    assert.equal(isJobSearchRunShownOnOtherBoard(source, null), false);
    assert.equal(isJobSearchRunShownOnOtherBoard(hub(), 'board-2'), false);
    assert.equal(isJobSearchRunShownOnOtherBoard(hub('hub-1', shownBy('board-1', 'older-run')), 'board-2'), false);
  } },
  { name: 'Rescrape admission: partition puts rescrape and cooldown entries in their own buckets', run: () => {
    const reuse = hub('hub-reuse');
    const rescrape = hub('hub-rescrape', shownBy('board-1'));
    const cooldown = hub('hub-cooldown', { ...shownBy('board-1'), sourceCoverage: coverage([HOUR, HOUR]) });
    const stuck = hub('hub-stuck', { testMode: true });
    delete stuck.data.careerSnapshotId;
    delete stuck.data.careerImportGeneration;
    delete stuck.data.careerImportCompilation;
    const parts = partitionJobBoardSourceAdmissions([reuse, rescrape, cooldown, stuck], { now: NOW, boardId: 'board-2' });
    assert.deepEqual(parts.reusable.map(e => e.sourceId), ['hub-reuse']);
    assert.deepEqual(parts.rescrape.map(e => e.sourceId), ['hub-rescrape']);
    assert.deepEqual(parts.cooldown.map(e => e.sourceId), ['hub-cooldown']);
    assert.deepEqual(parts.blocked.map(e => e.sourceId), ['hub-stuck']);
    assert.deepEqual(parts.fresh, []);
  } },
  { name: 'Rescrape capability: the minted capability is fresh for a done card and admits the Board scan', run: () => {
    const source = hub('hub-1', shownBy('board-1'));
    assert.equal(classify(source).kind, 'rescrape-terminal');
    const patch = buildJobHubRescanCapabilityPatch(source.data, { nodeId: 'hub-1', now: NOW });
    assert.ok(patch);
    assert.deepEqual(Object.keys(patch).sort(), [
      'careerImportCompilation', 'careerImportConsumption', 'careerImportFreshCapability', 'careerImportGeneration',
    ]);
    assert.equal(patch.careerImportConsumption, null);
    assert.equal(patch.careerImportFreshCapability, patch.careerImportGeneration);
    assert.equal(patch.careerImportCompilation.status, 'approved');
    assert.equal(patch.careerImportCompilation.careerSnapshotId, SNAPSHOT);
    const minted = { ...source, data: { ...source.data, ...patch } };
    const admission = jobCareerImportBoardAdmission(minted.data, {
      capability: patch.careerImportFreshCapability, boardRunId: 'board-run-1', nodeId: 'hub-1',
    });
    assert.equal(admission.kind, 'fresh');
    // Without the patch the old generation is not a fresh capability.
    assert.notEqual(jobCareerImportBoardAdmission(source.data, {
      capability: patch.careerImportFreshCapability, boardRunId: 'board-run-1', nodeId: 'hub-1',
    }).kind, 'fresh');
  } },
  { name: 'A Board search that stopped before saving any jobs: the earlier jobs on the card still read as shown', run: () => {
    // The search start clears the run id and records which shown run it keeps.
    const paused = extra => hub('hub-1', {
      jobRunId: null,
      resultDisposition: null,
      ...shownBy('board-1'),
      carriedResults: { runId: 'run-1', boardId: 'board-1', careerSnapshotId: SNAPSHOT },
      ...extra,
    });
    assert.deepStrictEqual(jobSearchShownRun(paused().data)?.boardId, 'board-1');
    assert.strictEqual(classify(paused()).kind, 'rescrape-terminal',
      'with a platform past its cooldown the Board may search the card again instead of reusing it for ever');
    assert.strictEqual(classify(paused({ sourceCoverage: coverage([HOUR, HOUR]) })).kind, 'reuse-terminal');
    assert.strictEqual(isJobSearchRunShownOnOtherBoard(paused(), 'board-2'), true,
      'another Board still leaves these jobs out');
    assert.strictEqual(jobSearchShownRunPatch(paused().data, { boardId: 'board-1', runId: 'run-1' }), null,
      'nothing is stamped while the card has no run id');
    // Anything less than the exact pair stays unshown.
    assert.strictEqual(jobSearchShownRun(paused({ carriedResults: null }).data), null, 'a very old result with no run id');
    assert.strictEqual(jobSearchShownRun(paused({ carriedResults: { runId: 'run-0', boardId: 'board-1', careerSnapshotId: SNAPSHOT } }).data), null);
    assert.strictEqual(jobSearchShownRun(paused({ carriedResults: { runId: 'run-1', boardId: 'board-2', careerSnapshotId: SNAPSHOT } }).data), null);
    assert.strictEqual(jobSearchShownRun(paused({ scoredJobs: [] }).data), null);
    assert.strictEqual(jobSearchShownRun(paused({ careerSnapshotId: 'b'.repeat(64) }).data), null, 'new career data since the search started');
    assert.strictEqual(classify(paused({ carriedResults: null })).kind, 'reuse-terminal');
    // A card with a run id is judged by that run id alone, as before.
    assert.strictEqual(jobSearchShownRun(hub('hub-1', { jobRunId: 'run-2', ...shownBy('board-1'), carriedResults: { runId: 'run-1', boardId: 'board-1', careerSnapshotId: SNAPSHOT } }).data), null);
  } },
  { name: 'Copy and paste: a paused Board search copied with its Board keeps reading as shown by the copied Board', run: () => {
    const search = hub('hub-1', { jobRunId: null, resultDisposition: null, ...shownBy('board-1'),
      carriedResults: { runId: 'run-1', boardId: 'board-1', careerSnapshotId: SNAPSHOT } });
    const board = { id: 'board-1', type: 'jobboard', data: {} };
    const clones = remapCopiedJobModuleReferences(
      [search, board],
      [{ ...search, id: 'hub-2' }, { ...board, id: 'board-2' }],
      new Map([['hub-1', 'hub-2'], ['board-1', 'board-2']]),
    );
    const copied = clones.find(node => node.id === 'hub-2');
    assert.strictEqual(copied.data.carriedResults.boardId, 'board-2');
    assert.strictEqual(jobSearchShownRun(copied.data)?.boardId, 'board-2');
  } },
  { name: 'Rescrape capability: no patch without a valid 64-hex snapshot id or a node id', run: () => {
    const data = hub().data;
    assert.equal(buildJobHubRescanCapabilityPatch({ ...data, careerSnapshotId: 'short' }, { nodeId: 'hub-1', now: NOW }), null);
    assert.equal(buildJobHubRescanCapabilityPatch({ ...data, careerSnapshotId: undefined }, { nodeId: 'hub-1', now: NOW }), null);
    assert.equal(buildJobHubRescanCapabilityPatch(data, { nodeId: '', now: NOW }), null);
  } },
  { name: 'Rescrape availability: platforms due, fresh and the earliest next eligible time', run: () => {
    const availability = jobSearchRescrapeAvailability(hub('hub-1', {
      sourceCoverage: coverage([2 * HOUR, 2 * DAY]),
    }).data, NOW);
    assert.deepEqual(availability.due, ['indeed']);
    assert.deepEqual(availability.fresh.map(f => f.sourceId), ['linkedin']);
    assert.equal(availability.nextEligibleAt, NOW - 2 * HOUR + DAY);
    const none = jobSearchRescrapeAvailability(hub().data, NOW);
    assert.equal(none.nextEligibleAt, null);
    assert.equal(none.fresh.length, 0);
  } },
  { name: 'Rescrape availability: platforms that cannot serve the search country are excluded like the run does', run: () => {
    const base = hub('hub-1', { enabledSourceIds: ['linkedin', 'usajobs'], sourceCoverage: {} }).data;
    const canada = jobSearchRescrapeAvailability(base, NOW);
    assert.ok(canada.sourceIds.includes('linkedin'));
    assert.ok(!canada.sourceIds.includes('usajobs'), 'usajobs cannot serve a Canada search');
    assert.ok(!canada.due.includes('usajobs'));
    const us = jobSearchRescrapeAvailability({
      ...base,
      searchLocation: { mode: 'city', city: 'Austin', subdivision: 'TX', country: 'US', value: 'Austin, TX' },
    }, NOW);
    assert.ok(us.sourceIds.includes('usajobs'));
  } },
  { name: 'Copy and paste: a Search copied with the Board that showed it is shown by the copied Board', run: () => {
    const search = { id: 'search-1', type: 'jobhub', data: { jobRunId: 'run-1', boardShownRun: { runId: 'run-1', boardId: 'board-1', shownAt: 1 } } };
    const board = { id: 'board-1', type: 'jobboard', data: {} };
    const withBoard = remapCopiedJobModuleReferences(
      [search, board],
      [{ ...search, id: 'search-2' }, { ...board, id: 'board-2' }],
      new Map([['search-1', 'search-2'], ['board-1', 'board-2']]),
    );
    assert.equal(withBoard.find(node => node.id === 'search-2').data.boardShownRun.boardId, 'board-2');
    const searchOnly = remapCopiedJobModuleReferences(
      [search],
      [{ ...search, id: 'search-2' }],
      new Map([['search-1', 'search-2']]),
    );
    assert.equal(searchOnly[0].data.boardShownRun.boardId, 'board-1',
      'a Search copied without its Board keeps the original claim, so its run is not shown twice');
  } },
  { name: 'Job Board live signature and all-done checks leave out runs shown on another Board exactly as Combine does', run: () => {
    const board = fs.readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
    assert.ok(board.includes('shownElsewhere: isJobSearchRunShownOnOtherBoard(n, id),'),
      'each connected module records whether another Board showed its run');
    assert.ok(board.includes("(m.hasPositiveResults || m.isAuthoritativeEmpty) && !m.shownElsewhere),"),
      'the render-time completed set (and so liveSignature) leaves those runs out like liveCombineInputs');
    assert.ok(board.includes('&& completedModules.length + settledElsewhereCount === connectedModules.length;')
      && board.includes('completedCount: completedModules.length + settledElsewhereCount,'),
    'a left-out run counts as settled, never as an unfinished Search');
    assert.ok(board.includes('inputsAtCombine.settled.length === liveConnectedCount')
      && board.includes('liveInputs.settled.length === liveInputs.all.length'),
    'Combine-time empty replacement uses the same settled count');
    assert.ok(board.includes('const displayedOriginIds = new Set(union.map(job => job?.originHubId).filter(Boolean));')
      && board.includes('if (!module.runId || !displayedOriginIds.has(module.id)) continue;'),
    'a Search is recorded as shown only when one of its rows is in the displayed set');
  } },
];
