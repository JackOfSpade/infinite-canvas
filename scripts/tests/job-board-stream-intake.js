import assert from 'node:assert/strict';
import {
  JOB_BOARD_REBUILD_MIN_GAP_ACTIVE_MS,
  JOB_BOARD_REBUILD_SETTLE_MS,
  JOB_BOARD_STREAM_ACTIVE_STATUS_MAX_AGE_MS,
  describeJobBoardStreamStatus,
  isJobBoardStreamRunId,
  jobBoardRebuildDelayMs,
  jobBoardStreamRunId,
  nextJobBoardIntakeDelayMs,
} from '../../src/utils/jobBoardStreamIntake.js';

const NOW = 1_800_000_000_000;

export default [
  {
    name: 'board stream rules: status lines are shown in the Board\'s own words, and only a recent one means "searching now"',
    run() {
      const at = NOW - 60_000;
      assert.deepEqual(describeJobBoardStreamStatus(null), {
        label: 'No listings yet', detail: 'Nothing has arrived from this Job Search yet. Start it from its own card.', active: false,
      });
      const progress = describeJobBoardStreamStatus({ code: 'source-progress', sourceId: 'glassdoor', queryIndex: 2, queryTotal: 10, page: 17, sent: 721, at }, { now: NOW });
      assert.deepEqual(progress, { label: 'Glassdoor: query 3 of 10, page 17', detail: 'Glassdoor has sent 721 listing(s) in this run so far.', active: true });
      assert.equal(describeJobBoardStreamStatus({ code: 'source-stopped', sourceId: 'indeed', at }, { now: NOW }).label, 'Indeed stopped');
      assert.equal(describeJobBoardStreamStatus({ code: 'source-finished', sourceId: 'newboard', at }, { now: NOW }).label, 'Newboard finished');
      assert.deepEqual([describeJobBoardStreamStatus({ code: 'run-finished', at }, { now: NOW }).active, describeJobBoardStreamStatus({ code: 'run-paused', at }, { now: NOW }).active], [false, false]);
      // A search that died mid-run leaves "reading" as its last word; that must not read as active for ever.
      const stale = describeJobBoardStreamStatus({ code: 'source-progress', sourceId: 'glassdoor', queryIndex: 0, page: 1, at: NOW - JOB_BOARD_STREAM_ACTIVE_STATUS_MAX_AGE_MS - 1 }, { now: NOW });
      assert.equal(stale.active, false);
      // Text from the stream is never shown: an unknown code gets the Board's own sentence.
      const unknown = describeJobBoardStreamStatus({ code: 'do-something', label: 'Injected text', at }, { now: NOW });
      assert.equal(unknown.label, 'Search status unknown');
      assert.equal(jobBoardStreamRunId('search-1'), 'stream:search-1');
      assert.equal(jobBoardStreamRunId(''), null);
      assert.deepEqual([isJobBoardStreamRunId('stream:search-1'), isJobBoardStreamRunId('search-1-1795'), isJobBoardStreamRunId(null)], [true, false, false]);
    },
  },
  {
    name: 'board stream rules: intake runs at once through a backlog and the Board rebuilds on its own, spaced out while a search is sending',
    run() {
      assert.equal(nextJobBoardIntakeDelayMs({ done: false }), 250);
      assert.equal(nextJobBoardIntakeDelayMs({ done: true }), 15_000);
      assert.deepEqual([1, 2, 3, 20].map(failures => nextJobBoardIntakeDelayMs({ done: true, failures })), [30_000, 60_000, 120_000, 15 * 60 * 1000]);
      // Nothing new, or the Board cannot build right now: no rebuild is planned.
      assert.equal(jobBoardRebuildDelayMs({ behind: false, canBuild: true, now: NOW }), null);
      assert.equal(jobBoardRebuildDelayMs({ behind: true, canBuild: false, now: NOW }), null);
      // The search has stopped sending: catch up after a short quiet period.
      assert.equal(jobBoardRebuildDelayMs({ behind: true, canBuild: true, streamActive: false, lastBuildEndedAt: NOW - 1000, now: NOW }), JOB_BOARD_REBUILD_SETTLE_MS);
      // Still sending: the first build is prompt, later ones keep their distance.
      assert.equal(jobBoardRebuildDelayMs({ behind: true, canBuild: true, streamActive: true, lastBuildEndedAt: 0, now: NOW }), JOB_BOARD_REBUILD_SETTLE_MS);
      assert.equal(jobBoardRebuildDelayMs({ behind: true, canBuild: true, streamActive: true, lastBuildEndedAt: NOW - 60_000, now: NOW }), JOB_BOARD_REBUILD_MIN_GAP_ACTIVE_MS - 60_000);
      assert.equal(jobBoardRebuildDelayMs({ behind: true, canBuild: true, streamActive: true, lastBuildEndedAt: NOW - JOB_BOARD_REBUILD_MIN_GAP_ACTIVE_MS - 1, now: NOW }), JOB_BOARD_REBUILD_SETTLE_MS);
      // A build that keeps failing waits longer each time rather than repeating at once.
      assert.equal(jobBoardRebuildDelayMs({ behind: true, canBuild: true, failures: 1, lastBuildEndedAt: NOW, now: NOW }), 60_000);
      assert.equal(jobBoardRebuildDelayMs({ behind: true, canBuild: true, failures: 3, lastBuildEndedAt: NOW, now: NOW }), 240_000);
      assert.equal(jobBoardRebuildDelayMs({ behind: true, canBuild: true, failures: 30, lastBuildEndedAt: NOW, now: NOW }), 15 * 60 * 1000);
    },
  },
];
