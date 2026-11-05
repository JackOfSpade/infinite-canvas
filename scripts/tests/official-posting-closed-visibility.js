import assert from 'node:assert/strict';
import { isJobCardVisible, jobCardClosedAtMostOfficialSource, jobCardClosedOfficially } from '../../src/utils/jobCardFilters.js';
import { computeJobTreeView } from '../../src/nodes/jobsearch/buildJobTree.js';
import { officialPostingStatesClosed } from '../../electron/ipc/officialPostingFields.js';
import { officialPostingNeedsRefresh } from '../../src/utils/officialPostingDisplay.js';
import { officialPostingOutranksClosedPage, settleBoardClosedRows } from '../../electron/ipc/officialPostingBoardClosed.js';
import { officialPostingSemanticInputHash } from '../../electron/ipc/officialPostingSemantic.js';

const HASH = 'a'.repeat(64);
const OFFICIAL = 'https://careers.northwind.test/job/42';
const row = (extra = {}) => ({ title: 'Dispatch Engineer', company: 'Northwind', location: 'Lakeview', source: 'linkedin', matchScore: 90,
  url: 'https://www.linkedin.com/jobs/view/1', sourceJobKey: 'k1', snippet: 'Build routing services.', ...extra });
const official = (job, extra = {}) => ({ level: 'L1', outcome: 'found', employer: 'Northwind', title: 'Dispatch Engineer', sourceUrl: OFFICIAL, officialApplyUrl: OFFICIAL,
  salary: { text: '', provenance: 'unknown' }, fetchedAt: '2026-11-04T00:00:00.000Z',
  trail: ['worker-research', 'comparative-match', 'semantic-match-v1'],
  semanticMatch: { version: 1, inputHash: officialPostingSemanticInputHash(job), sourceHash: HASH }, ...extra });
const closed = job => official(job, { outcome: 'closed', trail: ['worker-research', 'closed', 'closure-page-read', 'semantic-match-v1'] });
const rowWith = (make, extra = {}) => { const job = row(extra); return { ...job, officialPosting: make(job) }; };
const onBoardClosed = { listingLiveness: { verdict: 'closed', basis: 'structural', board: 'linkedin', at: '2026-11-04T00:00:00.000Z' } };

export default [
  {
    name: 'A card leaves view when the official posting is closed, under any filter, and returns when it is open',
    run() {
      const job = rowWith(closed);
      assert.equal(officialPostingStatesClosed(job.officialPosting), true);
      assert.equal(jobCardClosedOfficially(job), true);
      assert.equal(isJobCardVisible(job), false);
      assert.equal(isJobCardVisible(job, { showReviewCards: true, scoreThreshold: 0 }), false);
      assert.equal(isJobCardVisible(rowWith(official)), true, 'the same card with an open posting');
    },
  },
  {
    name: 'The listing decides only when no official posting is confirmed: a listing-closed card is hidden, and returns when an official posting is found open',
    run() {
      const hidden = row(onBoardClosed);
      assert.equal(jobCardClosedAtMostOfficialSource(hidden), true);
      assert.equal(isJobCardVisible(hidden), false, 'listing closed, no confirmed official posting');
      assert.equal(isJobCardVisible(hidden, { showReviewCards: true, scoreThreshold: 0 }), false);
      assert.equal(hidden.listingLiveness.verdict, 'closed', 'hiding keeps the data');
      const found = { ...hidden, officialPosting: official(hidden) };
      assert.equal(isJobCardVisible(found), true, 'the official posting is open, so the listing no longer decides');
      assert.equal(isJobCardVisible({ ...hidden, localApplication: { id: 'a1' } }), true, 'a generated application stays reachable');
      const unconfirmed = { ...hidden, officialPosting: official(hidden, { level: 'L5', outcome: 'ambiguous', trail: ['worker-research', 'semantic-uncertain'] }) };
      assert.equal(isJobCardVisible(unconfirmed), false, 'an unconfirmed result leaves the listing as the most official source');
      assert.equal(isJobCardVisible(rowWith(closed, { listingLiveness: { verdict: 'open', basis: 'structural', board: 'linkedin', at: '2026-11-04T00:00:00.000Z' } })), false, 'an official closure hides even an open listing');
    },
  },
  {
    name: 'A board saying closed, or an unfinished lookup, never hides a card by itself',
    run() {
      assert.equal(isJobCardVisible(rowWith(official, onBoardClosed)), true, 'board closed, official open');
      assert.equal(isJobCardVisible(row({ boardClosed: { board: 'linkedin', reason: 'closed', at: '2026-11-04T00:00:00.000Z' } })), true);
      for (const unconfirmed of [{ level: 'L5' }, { level: 'L6' }, { trail: ['worker-research', 'closed'] }, { sourceUrl: '' }]) {
        const job = rowWith(base => ({ ...closed(base), ...unconfirmed }));
        assert.equal(isJobCardVisible(job), true, JSON.stringify(unconfirmed));
      }
      const unfinished = rowWith(job => official(job, { level: 'L5', outcome: 'ambiguous', trail: ['worker-research', 'semantic-uncertain'] }));
      assert.equal(isJobCardVisible(unfinished), true);
    },
  },
  {
    name: 'A closure arriving on its own hides the card without moving hand-placed cards',
    run() {
      const card = (id, data, position) => ({ id, type: 'jobcard', hidden: false, position, data: { hubId: 'hub', _preserveTreeLayoutOnRestore: 'user-arranged', ...data } });
      const nodes = [{ id: 'hub', type: 'jobboard', position: { x: 0, y: 0 }, data: {} }, card('kept', rowWith(official), { x: 900, y: 700 }), card('gone', rowWith(closed), { x: 40, y: 40 })];
      const view = computeJobTreeView(nodes, 'hub', {}, undefined, false, { keepUserLayout: true });
      assert.equal(view.find(node => node.id === 'gone').hidden, true);
      assert.deepEqual(view.find(node => node.id === 'kept').position, { x: 900, y: 700 });
    },
  },
  {
    name: 'A closed card holding a generated application stays reachable',
    run() {
      assert.equal(isJobCardVisible(rowWith(closed, { localApplication: { id: 'a1' } })), true);
    },
  },
  {
    name: 'The Board tree hides only the closed card and drops a group left empty',
    run() {
      const group = (id, childIds, extra = {}) => ({ id, type: 'jobgroup', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', childIds, expanded: true, ...extra } });
      const card = (id, data) => ({ id, type: 'jobcard', hidden: true, position: { x: 0, y: 0 }, data: { hubId: 'hub', ...data } });
      const nodes = [{ id: 'hub', type: 'jobboard', position: { x: 0, y: 0 }, data: {} }, group('role-a', ['open', 'gone'], { level: 'role' }), group('role-b', ['gone-2'], { level: 'role' }),
        card('open', rowWith(official, onBoardClosed)), card('gone', rowWith(closed)), card('gone-2', rowWith(closed))];
      const view = computeJobTreeView(nodes, 'hub', {});
      const hidden = Object.fromEntries(view.map(node => [node.id, node.hidden]));
      assert.equal(hidden.open, false);
      assert.equal(hidden.gone, true);
      assert.equal(hidden['gone-2'], true);
      assert.equal(hidden['role-b'], true, 'a group with nothing left to show');
    },
  },
  {
    name: 'Official open keeps a board-closed row at every level, with or without a description',
    async run() {
      for (const level of ['L1', 'L2', 'L3', 'L4']) {
        for (const snippet of ['Build routing services.', '']) {
          for (const liveness of [onBoardClosed, { boardClosed: { board: 'linkedin', reason: 'closed', at: '2026-11-04T00:00:00.000Z' } }]) {
            const job = rowWith(base => official(base, { level, outcome: level === 'L4' ? 'link-only' : 'found' }), { snippet, ...liveness });
            const settled = await settleBoardClosedRows([job], { requireSemantic: true, researchDeferred: true, scoreSafe: candidate => Boolean(candidate.snippet) });
            assert.deepEqual([settled.kept.length, settled.dropped.length], [1, 0], `${level} ${snippet ? 'described' : 'no description'}`);
          }
        }
      }
    },
  },
  {
    name: 'Without an official open result, a board-closed row with nothing to show still leaves',
    async run() {
      const settled = await settleBoardClosedRows([row({ snippet: '', ...onBoardClosed })], { requireSemantic: true, researchDeferred: true, scoreSafe: () => false });
      assert.deepEqual([settled.kept.length, settled.dropped.length], [0, 1]);
      const stale = { ...row({ snippet: '', ...onBoardClosed }), officialPosting: official(row({ title: 'Another role' })) };
      const staleSettled = await settleBoardClosedRows([stale], { requireSemantic: true, researchDeferred: true, scoreSafe: () => false });
      assert.equal(staleSettled.kept.length, 0, 'a result proven for a different row is not this row\'s posting');
    },
  },
  {
    name: 'An open official posting outranks another page\'s closed verdict, but not its own page\'s',
    run() {
      const job = rowWith(official);
      assert.equal(officialPostingOutranksClosedPage(job, 'https://other-ats.test/j/9'), true);
      assert.equal(officialPostingOutranksClosedPage(job, ''), true);
      assert.equal(officialPostingOutranksClosedPage(job, OFFICIAL), false, 'that page is the official posting');
      assert.equal(officialPostingOutranksClosedPage(rowWith(closed), 'https://other-ats.test/j/9'), false);
      assert.equal(officialPostingOutranksClosedPage(row(), 'https://other-ats.test/j/9'), false);
    },
  },
  {
    name: 'An older closure not judged on the full page does not hide the card, and asks for a recheck',
    run() {
      const old = rowWith(job => official(job, { outcome: 'closed', trail: ['worker-research', 'closed', 'semantic-match-v1'] }));
      assert.equal(isJobCardVisible(old), true);
      assert.equal(officialPostingNeedsRefresh(old), true);
      assert.equal(officialPostingNeedsRefresh(rowWith(closed)), false);
    },
  },
];
