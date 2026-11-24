import assert from 'node:assert/strict';
import {
  forgetJobBoardIntake,
  holdJobBoardIntake,
  jobBoardIntakeHasWaiting,
  jobBoardIntakeSnapshot,
  jobBoardIntakeVersion,
  setJobBoardIntakeState,
  subscribeJobBoardIntake,
} from '../../src/utils/jobBoardIntakeCache.js';

const row = (n, streamId = 'search-1') => ({ title: `Engineer ${n}`, originHubId: streamId, matchScore: 80 });

export default [
  {
    name: 'board intake cache: a build holds its listings still and the next build gets what arrived meanwhile',
    run() {
      const boardId = 'board-cache-test';
      forgetJobBoardIntake(boardId);
      let notified = 0;
      const unsubscribe = subscribeJobBoardIntake(() => { notified += 1; });
      try {
        assert.equal(jobBoardIntakeSnapshot(boardId).rowsByStream.size, 0);
        setJobBoardIntakeState(boardId, { rows: [row(1), row(2), row(3, 'search-2')], filtered: [row(9)], statuses: { 'search-1': { code: 'source-progress' } }, summary: { scored: 3 } });
        const first = jobBoardIntakeSnapshot(boardId);
        assert.deepEqual([...first.rowsByStream.keys()], ['search-1', 'search-2']);
        assert.equal(first.rowsByStream.get('search-1').length, 2);
        assert.equal(first.filteredByStream.get('search-1').length, 1);
        assert.equal(jobBoardIntakeSnapshot(boardId), first, 'the snapshot is the same object until something changes');
        // A build starts.
        const release = holdJobBoardIntake(boardId);
        const versionHeld = jobBoardIntakeVersion(boardId);
        setJobBoardIntakeState(boardId, { rows: [row(1), row(2), row(3, 'search-2'), row(4)], statuses: { 'search-1': { code: 'run-finished' } }, summary: { scored: 4 } });
        const held = jobBoardIntakeSnapshot(boardId);
        assert.equal(held.rowsByStream.get('search-1').length, 2, 'the build still sees the listings it started with');
        assert.equal(held.rowsByStream, first.rowsByStream);
        assert.equal(held.statuses['search-1'].code, 'run-finished', 'status lines are display only and pass through');
        assert.equal(jobBoardIntakeHasWaiting(boardId), true);
        assert.notEqual(jobBoardIntakeVersion(boardId), versionHeld);
        // The build ends: what arrived is now what the Board reads.
        release();
        release();
        assert.equal(jobBoardIntakeSnapshot(boardId).rowsByStream.get('search-1').length, 3);
        assert.equal(jobBoardIntakeHasWaiting(boardId), false);
        assert.ok(notified >= 4);
        // Rows with no stream are left out rather than grouped under a blank id.
        setJobBoardIntakeState(boardId, { rows: [{ title: 'No origin' }, row(5)] });
        assert.deepEqual([...jobBoardIntakeSnapshot(boardId).rowsByStream.keys()], ['search-1']);
        forgetJobBoardIntake(boardId);
        assert.equal(jobBoardIntakeSnapshot(boardId).version, 0);
      } finally { unsubscribe(); forgetJobBoardIntake(boardId); }
    },
  },
];
