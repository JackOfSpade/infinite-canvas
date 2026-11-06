import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BOARD_STAGES, boardStageCards, compensationRowsFromCards, taxonomyRowsFromCards, rebuildRowFromCard,
  stageCardSnapshot, stageCardUnchanged, COMPENSATION_FIELDS, LISTING_FIELDS, compensationPatch, listingPatch, listingChangedGrouping,
  listingChangedSalaryInputs, finalSourceCountsOf,
} from '../../src/nodes/jobboard/boardStageRerun.js';
import { beginOfficialPostingPreparation, getOfficialPostingPreparation } from '../../src/utils/officialPostingPreparation.js';
import { isBoardCombineManualAiRunId, isBoardIndependentManualAiRunId, BOARD_STAGE_RUN_PREFIX } from '../../src/utils/jobBoardCareerOverride.js';
import { JOB_COMPENSATION_METHOD_VERSION, jobBoardSalaryNeedsRefresh } from '../../src/utils/jobCompensationVersion.js';

const card = (id, data = {}) => ({ id, type: 'jobcard', data: { hubId: 'board', title: 'SE', company: 'Acme', location: 'Toronto, ON',
  sourceJobKey: `key-${id}`, originHubId: 'search-1', matchScore: 80, careerDirection: 'Backend', salary: '$100K', source: 'linkedin', ...data } });

export default [
  {
    name: 'board stage reruns only touch the Board’s own unlocked, live cards',
    run: () => {
      const nodes = [card('a'), card('b', { locked: true }), card('c', { hubId: 'other' }), { id: 'g', type: 'jobgroup', data: { hubId: 'board' } }];
      assert.deepEqual(boardStageCards(nodes, 'board').map(node => node.id), ['a']);
    },
  },
  {
    name: 'salary rerun rebuilds Combine’s rows from cards plus the origin Search’s salary context',
    run: () => {
      const cards = [card('a', { compensationAssessment: { status: 'competitive' }, compensationCareerSnapshotId: 'x' }), card('b', { sourceJobKey: 'gone' })];
      const modules = [{ id: 'search-1', remoteResidences: { canada: { country: 'Canada' } },
        scoredJobs: [{ sourceJobKey: 'key-a', compensationContext: { seniority: 'senior' } }] }];
      const { rows, matched } = compensationRowsFromCards(cards, modules);
      assert.equal(matched, 1);
      assert.deepEqual(rows[0].compensationContext, { seniority: 'senior' });
      assert.deepEqual(rows[0].compensationRemoteResidences, { canada: { country: 'Canada' } });
      assert.equal(rows[0].compensationAssessment, undefined, 'the old answer is never sent back as input');
      assert.equal(rows[1].compensationContext, undefined, 'a card without a source row still gets researched from its own fields');
      assert.equal(rows[1].title, 'SE');
    },
  },
  {
    name: 'stage writes skip a card that changed while the stage ran',
    run: () => {
      const before = card('a', { compensationAssessment: { status: 'uncertain' } });
      const snapshot = stageCardSnapshot(before, COMPENSATION_FIELDS);
      assert.equal(stageCardUnchanged(before, snapshot, 'board', COMPENSATION_FIELDS), true);
      assert.equal(stageCardUnchanged(card('a', { compensationAssessment: { status: 'competitive' } }), snapshot, 'board', COMPENSATION_FIELDS), false);
      assert.equal(stageCardUnchanged(card('a', { compensationAssessment: { status: 'uncertain' }, locked: true }), snapshot, 'board', COMPENSATION_FIELDS), false);
      assert.equal(stageCardUnchanged(card('a', { compensationAssessment: { status: 'uncertain' }, sourceJobKey: 'other' }), snapshot, 'board', COMPENSATION_FIELDS), false);
      assert.equal(stageCardUnchanged(null, snapshot, 'board', COMPENSATION_FIELDS), false);
      assert.deepEqual(compensationPatch({ compensationAssessment: { personalRecommendation: { careerSnapshotId: 'snap' } } }),
        { compensationAssessment: { personalRecommendation: { careerSnapshotId: 'snap' } }, compensationCareerSnapshotId: 'snap' });
    },
  },
  {
    name: 'listing rerun writes only changed listing fields and regroups only when fit or role moved',
    run: () => {
      const cards = [card('a', { notes: 'mine', listingLiveness: { verdict: 'pending' } }), card('b')];
      const rows = [{ ...cards[0].data, listingLiveness: { verdict: 'live' }, notes: 'model must not write this' }, { ...cards[1].data }];
      assert.deepEqual(listingPatch(rows[0], cards[0]), { listingLiveness: { verdict: 'live' } });
      assert.deepEqual(listingPatch(rows[1], cards[1]), {});
      assert.ok(!LISTING_FIELDS.includes('notes') && !LISTING_FIELDS.includes('localApplication'));
      assert.equal(listingChangedGrouping(rows, cards), false);
      assert.equal(listingChangedGrouping([{ ...rows[0], matchScore: 60 }, rows[1]], cards), true);
      assert.equal(listingChangedGrouping([rows[0], { ...rows[1], careerDirection: 'Frontend' }], cards), true);
    },
  },
  {
    name: 'stage reruns flag salary after a rescore, regroup on posted-pay changes, and recount sources',
    run: () => {
      const cards = [card('a', { officialPosting: { salary: { text: '$100K' } } }), card('b', { source: 'indeed' })];
      const same = cards.map(c => ({ ...c.data }));
      assert.equal(listingChangedSalaryInputs(same, cards), false);
      assert.equal(listingChangedSalaryInputs([{ ...same[0], fitAssessment: { x: 1 } }, same[1]], cards), true);
      assert.equal(listingChangedGrouping([{ ...same[0], officialPosting: { salary: { text: '$150K' } } }, same[1]], cards), true);
      assert.deepEqual(finalSourceCountsOf(same), { linkedin: 1, indeed: 1 });
      const rescored = compensationRowsFromCards([card('a', { officialRescore: { contentHash: 'h' } })],
        [{ id: 'search-1', scoredJobs: [{ sourceJobKey: 'key-a', compensationContext: { seniority: 'senior' } }] }]);
      assert.equal(rescored.rows[0].compensationContext, undefined, 'a rescored row is researched without the old scorer context, as in Combine');
    },
  },
  {
    name: 'regroup sends the same taxonomy projection as Combine and reuses every card',
    run: () => {
      const row = rebuildRowFromCard(card('a', { matchScore: '81' }));
      assert.equal(row.reuseCardId, 'a');
      assert.deepEqual(taxonomyRowsFromCards([row]), [{ careerDirection: 'Backend', matchScore: 81, salary: '$100K', title: 'SE', source: 'linkedin' }]);
    },
  },
  {
    name: 'a stage rerun holds the Board claim Combine and scans refuse, without posing as the official refresh',
    run: () => {
      const claim = beginOfficialPostingPreparation({ canvasFilePath: '/c.json', nodeId: 'stage-board', purpose: 'lookup', owner: 'board-refresh', stage: 'compensation' });
      try {
        const held = getOfficialPostingPreparation('/c.json', 'stage-board');
        assert.equal(held.owner, 'board-refresh', 'Combine/scan admission checks see the Board as busy');
        assert.equal(held.stage, 'compensation', 'the official-refresh hook can tell it is not its own run');
        assert.equal(beginOfficialPostingPreparation({ canvasFilePath: '/c.json', nodeId: 'stage-board', purpose: 'lookup', owner: 'board-refresh' }), null,
          'a second stage or the official refresh cannot start meanwhile');
      } finally { claim.finish(); }
      const plain = beginOfficialPostingPreparation({ canvasFilePath: '/c.json', nodeId: 'card-x', purpose: 'lookup', stage: 'compensation' });
      assert.equal(plain.stage, null, 'only a Board claim carries a stage');
      plain.finish();
    },
  },
  {
    name: 'stage run ids never become Combine recovery state',
    run: () => {
      const runId = `${BOARD_STAGE_RUN_PREFIX}compensation:123`;
      assert.equal(isBoardIndependentManualAiRunId(runId), true);
      assert.equal(isBoardCombineManualAiRunId(runId), false);
      assert.equal(isBoardCombineManualAiRunId('job-board:abc'), true);
    },
  },
  {
    name: 'saved boards report salary analysis as outdated after the posted-band change',
    run: () => {
      assert.ok(JOB_COMPENSATION_METHOD_VERSION >= 3);
      assert.equal(jobBoardSalaryNeedsRefresh({ resultCount: 5, salaryCareerSnapshotId: 's', salaryMethodVersion: 2 }, 's'), true);
      assert.equal(jobBoardSalaryNeedsRefresh({ resultCount: 5, salaryCareerSnapshotId: 's', salaryMethodVersion: JOB_COMPENSATION_METHOD_VERSION }, 's'), false);
    },
  },
  {
    name: 'the Board wires each stage rerun and stamps salary freshness after a salary-only run',
    run: () => {
      const board = fs.readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      for (const stage of Object.keys(BOARD_STAGES)) assert.ok(board.includes(`${stage}: run`), `stage ${stage} is wired`);
      assert.ok(board.includes('salaryMethodVersion: JOB_COMPENSATION_METHOD_VERSION } : null'), 'salary rerun clears the outdated marker');
      assert.ok(board.includes('!cards[index]?.data?.localApplication'), 'listing reruns never remove application cards');
    },
  },
];
