import assert from 'node:assert';
import fs from 'node:fs';
import {
  carriedJobsForTerminal,
  carriedTerminalRows,
  jobSearchCarriedResultsMarker,
  mergeCarriedJobs,
  withCarriedJobsTerminalPatch,
} from '../../src/utils/jobSearchCarriedResults.js';

const SNAPSHOT = 'c'.repeat(64);
const OTHER_SNAPSHOT = 'd'.repeat(64);
const job = (title, extra = {}) => ({
  title, company: 'Example Co', location: 'Toronto, ON', source: 'linkedin',
  url: `https://jobs.example.test/${encodeURIComponent(title)}`, matchScore: 80, careerSnapshotId: SNAPSHOT, ...extra,
});
const shownCard = (overrides = {}) => ({
  careerSnapshotId: SNAPSHOT,
  jobRunId: 'run-1',
  scoredJobs: [job('Old A'), job('Old B')],
  boardShownRun: { runId: 'run-1', boardId: 'board-1', shownAt: 1 },
  ...overrides,
});

export default [
  {
    name: 'Carried results: a re-scan started by the Board that shows the jobs keeps them; any other Board replaces them',
    run: () => {
      assert.deepEqual(jobSearchCarriedResultsMarker(shownCard(), { orchestratorNodeId: 'board-1' }),
        { runId: 'run-1', boardId: 'board-1', careerSnapshotId: SNAPSHOT });
      assert.equal(jobSearchCarriedResultsMarker(shownCard(), { orchestratorNodeId: 'board-2' }), null,
        'a different (or new, after deletion) Board treats the shown jobs as reviewed');
      assert.equal(jobSearchCarriedResultsMarker(shownCard(), {}), null, 'only a Board-run search carries');
      assert.equal(jobSearchCarriedResultsMarker(shownCard({ boardShownRun: null }), { orchestratorNodeId: 'board-1' }), null,
        'unshown jobs are never the carry case (they are combined, not re-scraped)');
      assert.equal(jobSearchCarriedResultsMarker(shownCard({ scoredJobs: [] }), { orchestratorNodeId: 'board-1' }), null);
    },
  },
  {
    name: 'Carried results: a retried re-scan keeps the saved decision after the run id was cleared',
    run: () => {
      const retried = shownCard({ jobRunId: null, carriedResults: { runId: 'run-1', boardId: 'board-1', careerSnapshotId: SNAPSHOT } });
      assert.deepEqual(jobSearchCarriedResultsMarker(retried, { orchestratorNodeId: 'board-1' }),
        { runId: 'run-1', boardId: 'board-1', careerSnapshotId: SNAPSHOT });
      assert.equal(jobSearchCarriedResultsMarker(retried, { orchestratorNodeId: 'board-2' }), null);
      assert.equal(jobSearchCarriedResultsMarker({ ...retried, careerSnapshotId: OTHER_SNAPSHOT }, { orchestratorNodeId: 'board-1' }), null,
        'new career data never carries rows scored under the old snapshot');
    },
  },
  {
    name: 'Carried results: a finishing run merges the earlier rows once, without duplicates or rows from another snapshot',
    run: () => {
      const card = shownCard({
        jobRunId: null,
        carriedResults: { runId: 'run-1', boardId: 'board-1', careerSnapshotId: SNAPSHOT },
        scoredJobs: [job('Old A'), job('Old B'), job('Old C', { careerSnapshotId: OTHER_SNAPSHOT })],
      });
      const carried = carriedJobsForTerminal(card, { jobRunId: 'run-2', careerSnapshotId: SNAPSHOT });
      assert.deepEqual(carried.map(row => row.title), ['Old A', 'Old B']);
      assert.deepEqual(carriedJobsForTerminal(card, { jobRunId: 'run-1', careerSnapshotId: SNAPSHOT }), [],
        'the run that was carried from never merges itself');
      assert.deepEqual(carriedJobsForTerminal(card, { jobRunId: 'run-2', careerSnapshotId: OTHER_SNAPSHOT }), []);
      assert.deepEqual(carriedJobsForTerminal({ ...card, carriedResults: null }, { jobRunId: 'run-2', careerSnapshotId: SNAPSHOT }), []);
      const merged = mergeCarriedJobs([job('New A'), job('Old A')], carried);
      assert.deepEqual(merged.map(row => row.title), ['New A', 'Old A', 'Old B'],
        'a listing found again is kept once, as the new row');
    },
  },
  {
    name: 'Carried results: a re-scan that finds nothing new keeps the shown jobs and its own disposition',
    run: () => {
      const card = shownCard({
        jobRunId: 'run-2',
        carriedResults: { runId: 'run-1', boardId: 'board-1', careerSnapshotId: SNAPSHOT },
      });
      const patch = withCarriedJobsTerminalPatch(card, {
        hubState: 'done', scoredJobs: [], resultCount: 0, totalScoredCount: 0, finalSourceCounts: {},
        jobRunId: 'run-2', resultDisposition: 'empty-complete', rerunOutcome: 'no-new-results',
      }, { careerSnapshotId: SNAPSHOT });
      assert.deepEqual(patch.scoredJobs.map(row => row.title), ['Old A', 'Old B']);
      assert.equal(patch.resultCount, 2);
      assert.equal(patch.totalScoredCount, 2);
      assert.deepEqual(patch.finalSourceCounts, { linkedin: 2 });
      assert.equal(patch.resultDisposition, 'empty-complete', 'the run still found nothing new');
      assert.equal(patch.carriedResults, null);
      assert.equal(patch.carriedJobCount, 2);
      const replaced = withCarriedJobsTerminalPatch({ ...card, carriedResults: null }, {
        hubState: 'done', scoredJobs: [], jobRunId: 'run-2', resultDisposition: 'empty-complete',
      }, { careerSnapshotId: SNAPSHOT });
      assert.deepEqual(replaced.scoredJobs, [], 'without a carry decision the run replaces as before');
      assert.equal(replaced.carriedResults, null);
      assert.equal(replaced.carriedJobCount, 0);
    },
  },
  {
    name: 'Carried results: every terminal commit of a Board re-scan applies the decision recorded at the run start',
    run: () => {
      const search = fs.readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      assert(search.includes(`          : jobSearchCarriedResultsMarker(laneTurnData, {
            orchestratorNodeId: queueManagedByBoard ? orchestratorNodeId : null,
          }),`), 'the fresh-run setup records whether this run adds or replaces');
      assert(search.includes('const displayed = mergeCarriedJobs(freshlyScored, carriedJobs);')
        && search.includes('carriedJobsForTerminal(getNode(id)?.data, { jobRunId, careerSnapshotId: resolvedCareerSnapshotId })'),
      'the scored finish merges the kept rows');
      assert(search.includes('        freshlyScored.length,\n        moduleFingerprint(displayed),'),
        'the receipt counts this run\'s own rows and fingerprints what the card holds');
      const zeroCommits = (search.match(/return withCarriedJobsTerminalPatch\(node\?\.data, \{/g) || []).length;
      assert.equal(zeroCommits, 6, 'every zero-new-result terminal commit keeps the shown jobs');
      const done = fs.readFileSync(new URL('../../src/nodes/jobsearch/JobSearchDoneState.jsx', import.meta.url), 'utf8');
      assert(done.includes("`${jobsLabel(count - keptCount, 'new job', 'new jobs')} · ${keptCount} kept from earlier`"),
        'the card says how many jobs are new and how many were kept');
    },
  },
  {
    name: 'Carried results: a retry after a failed attempt that already stamped its own run id still carries',
    run: () => {
      const failed = shownCard({
        jobRunId: 'run-2-failed',
        resultDisposition: 'incomplete',
        carriedResults: { runId: 'run-1', boardId: 'board-1', careerSnapshotId: SNAPSHOT },
      });
      assert.deepEqual(jobSearchCarriedResultsMarker(failed, { orchestratorNodeId: 'board-1' }),
        { runId: 'run-1', boardId: 'board-1', careerSnapshotId: SNAPSHOT });
      assert.equal(jobSearchCarriedResultsMarker(failed, { orchestratorNodeId: 'board-2' }), null);
    },
  },
  {
    name: 'Carried results: a zero-new commit can name its run explicitly, and its receipt rows match what it commits',
    run: () => {
      const card = shownCard({ jobRunId: 'run-2', carriedResults: { runId: 'run-1', boardId: 'board-1', careerSnapshotId: SNAPSHOT } });
      const patch = withCarriedJobsTerminalPatch(card, { hubState: 'done', scoredJobs: [], resultDisposition: 'preference-filtered' },
        { careerSnapshotId: SNAPSHOT, jobRunId: 'run-2' });
      assert.deepEqual(patch.scoredJobs.map(row => row.title), ['Old A', 'Old B'],
        'a patch without its own jobRunId still keeps the shown jobs when the caller names the run');
      assert.deepEqual(carriedTerminalRows(card, { jobRunId: 'run-2', careerSnapshotId: SNAPSHOT }), patch.scoredJobs,
        'the receipt fingerprint is taken over exactly the rows the commit writes');
      const search = fs.readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      assert.equal((search.match(/moduleFingerprint\(carriedTerminalRows\(getNode\(id\)\?\.data, \{ jobRunId: /g) || []).length, 6,
        'every zero-new receipt fingerprints the kept rows');
      assert(search.includes('carriedResults: recoveredPreSearchContext\n          ? (laneTurnData.carriedResults ?? null)'),
        'a resumed pre-search handoff keeps the saved decision');
    },
  },
];
