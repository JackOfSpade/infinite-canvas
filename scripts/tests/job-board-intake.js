import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJobListingStream } from '../../electron/ipc/jobListingStream.js';
import { createListingStreamEmitter } from '../../electron/ipc/jobs/listingStreamEmitter.js';
import {
  appendBoardListingRecords,
  boardListingMark,
  boardListingStorePath,
  compactBoardListingStore,
  loadBoardListingState,
  removeBoardListingStore,
  summarizeBoardListingState,
} from '../../electron/ipc/jobs/boardListingStore.js';
import { runBoardIntakeStep, runBoardReevaluationStep } from '../../electron/ipc/jobs/boardIntake.js';
import { jobAndVariantKeys } from '../../src/utils/jobListingIdentity.js';

const T0 = Date.UTC(2026, 10, 23, 12, 0, 0);
const CAREER = 'c'.repeat(64);
const LONG = 'Builds customer-facing product features end to end. '.repeat(12);
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'job-board-intake-test-'));
const job = (n, extra = {}) => ({
  title: `Engineer ${n}`, company: 'Example Co', location: 'Austin, TX', source: 'indeed',
  url: `https://www.indeed.com/viewjob?jk=${String(n).padStart(16, '0')}`, snippet: LONG, ...extra,
});

/** A Board over real stream and store files, with plain functions standing in for AI and history. */
function board(dir, { seen = [], applied = [], filteredTitles = [], wrongRoleTitles = [], failScoreTitles = [] } = {}) {
  const streamRoot = path.join(dir, 'streams');
  const storePath = boardListingStorePath(path.join(dir, 'canvas.json'), 'board-1');
  const calls = { evaluate: [], score: [], saves: 0 };
  let clock = T0;
  let failSave = false;
  const deps = {
    readStream: (streamId, position, options) => readJobListingStream(streamRoot, streamId, position, options),
    loadSeen: async () => ({
      dropSeen: jobs => ({
        seen: jobs.filter(j => seen.includes(j.title)),
        applied: jobs.filter(j => applied.includes(j.title)),
      }),
    }),
    hasDescription: j => String(j.snippet || '').length >= 200,
    filterLanguage: jobs => jobs.filter(j => j.language !== 'fr'),
    evaluate: async ({ jobs, run }) => {
      calls.evaluate.push({ titles: jobs.map(j => j.title), plan: run.jobPreferences || '' });
      const accepted = [];
      const filtered = [];
      jobs.forEach((j, index) => {
        if (wrongRoleTitles.includes(j.title)) return;
        const judged = { ...j, roleScreen: { outcome: 'match' }, preferenceAssessment: { status: filteredTitles.includes(j.title) ? 'filtered' : 'accepted' } };
        (filteredTitles.includes(j.title) ? filtered : accepted).push({ index, job: judged });
      });
      return { accepted, filtered };
    },
    score: async ({ jobs, careerSnapshotId }) => {
      calls.score.push({ titles: jobs.map(j => j.title), careerSnapshotId });
      return jobs.map(j => (failScoreTitles.includes(j.title) ? { ...j, unscored: true } : { ...j, matchScore: 80, careerSnapshotId }));
    },
    save: async (records) => {
      if (failSave) throw new Error('disk full');
      calls.saves += 1;
      await appendBoardListingRecords(storePath, records, { now: (clock += 1) });
    },
  };
  const emitter = (runId = 'run-1', streamId = 'search-1') => createListingStreamEmitter({
    root: streamRoot, streamId, runId, location: 'United States', now: () => (clock += 1),
  });
  const step = async (extra = {}) => runBoardIntakeStep({ streamIds: ['search-1'], state: await loadBoardListingState(storePath), deps, ...extra });
  const drain = async (extra = {}) => {
    let last;
    for (let i = 0; i < 50; i += 1) { last = await step(extra); if (last.done) return last; }
    throw new Error('intake did not finish');
  };
  const rows = async () => Object.fromEntries([...(await loadBoardListingState(storePath)).rows.values()].map(r => [r.job?.title || r.key, r.reason ? `${r.state}:${r.reason}` : r.state]));
  return { streamRoot, storePath, deps, calls, emitter, step, drain, rows, failSaves: (on) => { failSave = on; } };
}

export default [
  {
    name: 'board intake: listings are judged and scored as they arrive, each by the search that found it',
    async run() {
      const dir = tempDir();
      try {
        const b = board(dir, { seen: ['Engineer 2'], applied: ['Engineer 3'], filteredTitles: ['Engineer 4'], wrongRoleTitles: ['Engineer 5'] });
        const search = b.emitter();
        await search.runStarted({ careerSnapshotId: CAREER, jobPreferences: 'product roles' });
        await search.page({ sourceId: 'indeed', queryIndex: 0, queryTotal: 2, page: 1, jobs: [
          job(1), job(2), job(3), job(4), job(5), job(6, { language: 'fr' }), job(7, { snippet: '' }),
        ] });
        // The scrape is still running; the Board already has its first results.
        let result = await b.drain({ deletedKeys: [] });
        const kept = Object.fromEntries(Object.entries(await b.rows()).filter(([title]) => title.startsWith('Engineer')));
        assert.deepEqual(kept, { 'Engineer 1': 'scored', 'Engineer 4': 'filtered', 'Engineer 7': 'waiting' });
        assert.deepEqual(summarizeBoardListingState(await loadBoardListingState(b.storePath)), {
          scored: 1, filtered: 1, waiting: 1, unscored: 0, dropped: 4, droppedByReason: { seen: 1, applied: 1, role: 1, language: 1 }, total: 7,
        });
        assert.deepEqual(b.calls.evaluate, [{ titles: ['Engineer 1', 'Engineer 4', 'Engineer 5'], plan: 'product roles' }],
          'seen, applied, wrong-language and undescribed listings never reach the preference check');
        assert.deepEqual(b.calls.score, [{ titles: ['Engineer 1'], careerSnapshotId: CAREER }]);
        assert.equal(result.streams['search-1'].status.code, 'source-progress');
        assert.equal(result.streams['search-1'].status.queryTotal, 2);
        assert.equal(result.streams['search-1'].atEnd, true);
        // A dropped listing keeps no text; a kept one does.
        const state = await loadBoardListingState(b.storePath);
        assert.ok([...state.rows.values()].every(r => (r.state === 'dropped') === (r.job === null)));
        // More arrives later, including the description that was owed.
        await search.page({ sourceId: 'indeed', queryIndex: 0, page: 2, jobs: [job(8), job(7)] });
        await search.status('run-finished', {});
        result = await b.drain();
        assert.equal((await b.rows())['Engineer 8'], 'scored');
        assert.equal((await b.rows())['Engineer 7'], 'scored', 'a waiting listing is judged once its description arrives');
        assert.equal(result.streams['search-1'].status.code, 'run-finished');
        assert.deepEqual(b.calls.score.map(c => c.titles), [['Engineer 1'], ['Engineer 8', 'Engineer 7']]);
        // Nothing new: a further step reads nothing and calls no AI.
        const before = { evaluate: b.calls.evaluate.length, saves: b.calls.saves };
        result = await b.step();
        assert.deepEqual({ done: result.done, read: result.counts.read }, { done: true, read: 0 });
        assert.deepEqual({ evaluate: b.calls.evaluate.length, saves: b.calls.saves }, before);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  },
  {
    name: 'board intake: a resent listing costs nothing, a changed one is judged again, a deleted one stays gone',
    async run() {
      const dir = tempDir();
      try {
        const b = board(dir);
        const search = b.emitter();
        await search.runStarted({ careerSnapshotId: CAREER });
        await search.page({ sourceId: 'indeed', queryIndex: 0, page: 1, jobs: [job(1), job(2)] });
        await b.drain();
        assert.equal(b.calls.score.length, 1);
        // A resumed run sends its saved listings again (a new writer has no memory of what was sent).
        const resumed = b.emitter();
        await resumed.runStarted({ careerSnapshotId: CAREER, resumed: true });
        await resumed.page({ sourceId: 'indeed', jobs: [job(1), job(2)] });
        let result = await b.drain();
        assert.equal(result.counts.unchanged, 2);
        assert.equal(b.calls.score.length, 1, 'unchanged listings are not scored twice');
        // The user deletes Engineer 2's card; later the listing changes and is sent again.
        const deletedKeys = jobAndVariantKeys(job(2));
        await resumed.update([job(1, { snippet: `${LONG} Now hybrid.` }), job(2, { snippet: `${LONG} Reposted.` })]);
        result = await b.drain({ deletedKeys });
        assert.deepEqual({ scored: result.counts.scored, deleted: result.counts.deleted }, { scored: 1, deleted: 1 });
        assert.equal(b.calls.score.at(-1).titles.join(), 'Engineer 1', 'the changed listing still on the Board is scored again');
        const state = await loadBoardListingState(b.storePath);
        const deletedRow = [...state.rows.values()].find(r => r.state === 'dropped');
        assert.equal(deletedRow.reason, 'deleted');
        // Even a further change never brings a deleted listing back.
        await resumed.update([job(2, { snippet: `${LONG} Reposted again.` })]);
        result = await b.drain();
        assert.equal(result.counts.unchanged, 1);
        assert.equal((await loadBoardListingState(b.storePath)).rows.get(deletedRow.key).state, 'dropped');
        // A listing already shown is not removed by the record of having shown it.
        const shown = board(dir + '-shown', { seen: ['Engineer 1'] });
        fs.mkdirSync(dir + '-shown', { recursive: true });
        try {
          const s2 = shown.emitter();
          await s2.runStarted({ careerSnapshotId: CAREER });
          await appendBoardListingRecords(shown.storePath, [{ t: 'row', key: [...state.rows.keys()][0], streamId: 'search-1', runId: 'run-1', state: 'scored', mark: 'old', job: job(1) }], { now: T0 });
          await s2.page({ sourceId: 'indeed', queryIndex: 0, page: 1, jobs: [job(1, { snippet: `${LONG} Edited.` })] });
          result = await shown.drain();
          assert.deepEqual({ scored: result.counts.scored, seen: result.counts.seen }, { scored: 1, seen: 0 });
        } finally { fs.rmSync(dir + '-shown', { recursive: true, force: true }); }
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  },
  {
    name: 'board intake: a long backlog is taken in steps, and an interrupted step loses nothing and redoes little',
    async run() {
      const dir = tempDir();
      try {
        const b = board(dir);
        const search = b.emitter();
        await search.runStarted({ careerSnapshotId: CAREER });
        await search.page({ sourceId: 'indeed', queryIndex: 0, page: 1, jobs: Array.from({ length: 7 }, (_, n) => job(n + 1)) });
        let result = await b.step({ listingsPerStep: 3 });
        assert.deepEqual({ done: result.done, scored: result.counts.scored }, { done: false, scored: 3 });
        const afterFirst = (await loadBoardListingState(b.storePath)).positions.get('search-1');
        // The save fails: the position must not move and no listing may be lost.
        b.failSaves(true);
        await assert.rejects(() => b.step({ listingsPerStep: 3 }), /disk full/u);
        assert.deepEqual((await loadBoardListingState(b.storePath)).positions.get('search-1'), afterFirst);
        b.failSaves(false);
        result = await b.drain({ listingsPerStep: 3 });
        assert.equal(summarizeBoardListingState(await loadBoardListingState(b.storePath)).scored, 7);
        assert.deepEqual(b.calls.score.map(c => c.titles.length), [3, 3, 3, 1], 'only the interrupted three were redone');
        // The position record follows the rows it covers in every save.
        const lines = fs.readFileSync(b.storePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const firstSave = lines.slice(0, lines.findIndex(record => record.t === 'pos') + 1).map(record => record.t);
        assert.deepEqual(firstSave, ['run', 'row', 'row', 'row', 'status', 'pos'], 'rows first, the position last');
        assert.ok(lines.every((record, at) => record.t !== 'pos' || at === lines.length - 1 || ['run', 'row', 'status'].includes(lines[at + 1].t)));
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  },
  {
    name: 'board intake: listings that could not be scored are judged again later, and the Board can re-evaluate what it holds',
    async run() {
      const dir = tempDir();
      try {
        const b = board(dir, { failScoreTitles: ['Engineer 2'] });
        const search = b.emitter();
        await search.runStarted({ jobPreferences: 'product roles' }); // no approved career data yet
        await search.page({ sourceId: 'indeed', queryIndex: 0, page: 1, jobs: [job(1), job(2)] });
        await b.drain();
        assert.deepEqual(await b.rows(), { 'Engineer 1': 'unscored:no-career', 'Engineer 2': 'unscored:no-career' });
        assert.equal(b.calls.score.length, 0);
        // The Board gets career data of its own: the unscored listings are judged again from the Board's record.
        const reevaluate = async (select) => runBoardReevaluationStep({ state: await loadBoardListingState(b.storePath), select, careerSnapshotId: CAREER, deps: b.deps });
        let result = await reevaluate(row => row.state === 'unscored');
        assert.deepEqual({ done: result.done, scored: result.counts.scored, unscored: result.counts.unscored }, { done: true, scored: 1, unscored: 1 });
        assert.deepEqual(await b.rows(), { 'Engineer 1': 'scored', 'Engineer 2': 'unscored:scoring-failed' });
        assert.equal(b.calls.evaluate.at(-1).plan, 'product roles', 'still judged by the preferences of the run that found them');
        // Re-evaluating every kept listing (new career data) starts from what the search sent.
        result = await reevaluate(row => row.state === 'scored');
        assert.equal(result.counts.scored, 1);
        const state = await loadBoardListingState(b.storePath);
        const scored = [...state.rows.values()].find(r => r.state === 'scored');
        assert.equal(scored.job.matchScore, 80);
        assert.equal(scored.mark, boardListingMark(job(1)), 'the mark still names what the search sent, so a re-read stays free');
        const none = await reevaluate(() => false);
        assert.deepEqual({ done: none.done, remaining: none.remaining }, { done: true, remaining: 0 });
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  },
  {
    name: 'board listing store: newest record wins, compaction keeps the same content, and a removed Board leaves nothing',
    async run() {
      const dir = tempDir();
      try {
        const storePath = boardListingStorePath(path.join(dir, 'canvas.json'), 'board/../x');
        assert.equal(path.dirname(storePath), dir, 'a Board id cannot place the file elsewhere');
        assert.equal(boardListingStorePath('relative.json', 'b'), null);
        for (let n = 0; n < 30; n += 1) {
          await appendBoardListingRecords(storePath, [
            { t: 'row', key: 'k1', streamId: 's', runId: 'r', state: 'waiting', mark: `m${n}`, job: job(1, { snippet: `v${n}` }) },
            { t: 'pos', streamId: 's', position: { day: '2026-11-23', offset: n } },
          ], { now: T0 + n });
        }
        await appendBoardListingRecords(storePath, [{ t: 'row', key: 'k2', streamId: 's', runId: 'r', state: 'dropped', reason: 'seen', mark: 'x', job: job(2) }], { now: T0 + 99 });
        fs.appendFileSync(storePath, '{"t":"row","key":"torn');
        const before = await loadBoardListingState(storePath);
        assert.equal(before.rows.get('k1').job.snippet, 'v29');
        assert.equal(before.rows.get('k2').job, null);
        assert.deepEqual(before.positions.get('s'), { day: '2026-11-23', offset: 29 });
        assert.equal(await compactBoardListingStore(storePath, { now: T0 + 100, minRecords: 10 }), true);
        const after = await loadBoardListingState(storePath);
        assert.equal(after.records, 3);
        assert.deepEqual([...after.rows.keys()], ['k1', 'k2']);
        assert.equal(after.rows.get('k1').mark, 'm29');
        assert.deepEqual(after.positions.get('s'), { day: '2026-11-23', offset: 29 });
        assert.equal(fs.readFileSync(storePath, 'utf8').trim().split('\n').at(-1).includes('"t":"pos"'), true, 'positions are written last');
        assert.equal(await compactBoardListingStore(storePath, { now: T0 + 101, minRecords: 10 }), false, 'nothing to gain');
        await appendBoardListingRecords(storePath, [{ t: 'forget', streamId: 's' }], { now: T0 + 102 });
        assert.equal((await loadBoardListingState(storePath)).positions.has('s'), false);
        assert.equal((await loadBoardListingState(storePath)).rows.size, 2, 'cards already shown are kept when a stream is disconnected');
        await removeBoardListingStore(storePath);
        assert.equal(fs.existsSync(storePath), false);
        assert.equal((await loadBoardListingState(storePath)).rows.size, 0);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  },
  {
    name: 'board intake: two connected searches are read side by side, each from its own position',
    async run() {
      const dir = tempDir();
      try {
        const b = board(dir);
        const first = b.emitter('run-a', 'search-1');
        const second = b.emitter('run-b', 'search-2');
        await first.runStarted({ careerSnapshotId: CAREER, jobPreferences: 'product roles' });
        await second.runStarted({ careerSnapshotId: CAREER, jobPreferences: 'data roles' });
        await first.page({ sourceId: 'indeed', queryIndex: 0, page: 1, jobs: [job(1)] });
        await second.page({ sourceId: 'indeed', queryIndex: 0, page: 1, jobs: [job(2)] });
        const result = await runBoardIntakeStep({ streamIds: ['search-1', 'search-2', 'search-1'], state: await loadBoardListingState(b.storePath), deps: b.deps });
        assert.equal(result.done, true);
        assert.deepEqual(Object.keys(result.streams), ['search-1', 'search-2']);
        assert.deepEqual(b.calls.evaluate, [{ titles: ['Engineer 1'], plan: 'product roles' }, { titles: ['Engineer 2'], plan: 'data roles' }]);
        const state = await loadBoardListingState(b.storePath);
        assert.deepEqual([...state.rows.values()].map(r => r.streamId), ['search-1', 'search-2']);
        assert.equal(state.positions.size, 2);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  },
];
