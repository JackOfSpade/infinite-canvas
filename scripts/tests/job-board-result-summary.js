import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bundleComponent, withDom } from './fixtures/handoff-bridge/mountComponent.js';
import { attachProtectedCards, consolidateJobLocations } from '../../src/utils/jobLocationConsolidation.js';
import { buildJobTreeNodes } from '../../src/nodes/jobsearch/buildJobTree.js';
import { unionScoredJobs } from '../../src/nodes/jobboard/mergeJobs.js';
import { officialPostingPreparationSourceKey, projectOfficialPostingGenerationJob } from '../../src/utils/officialPostingPreparation.js';

async function inspectSummary(props, inspect) {
  const bundle = await bundleComponent('src/nodes/jobboard/JobBoardDoneState.jsx');
  try {
    await withDom(async window => {
      const { React, createRoot, act, JobBoardDoneState } = bundle.module;
      const root = createRoot(window.document.getElementById('root'));
      try {
        await act(async () => root.render(React.createElement(JobBoardDoneState, props)));
        await inspect(window.document);
      } finally { await act(async () => root.unmount()); }
    });
  } finally { await bundle.dispose(); }
}

export default [
  {
    name: 'Board official posting refresh is available without rebuilding and remains cancellable while checking',
    async run() {
      await inspectSummary({ resultCount: 2, onRefreshOfficialPostings() {} }, document => {
        const button = [...document.querySelectorAll('button')].find(button => button.textContent === 'Refresh official postings');
        assert(button && !button.disabled);
      });
      await inspectSummary({ resultCount: 2, onRefreshOfficialPostings() {}, onCancelOfficialPostingRefresh() {},
        officialPostingRefreshing: true, officialPostingProgress: { completed: 1, total: 2 } }, document => {
        const check = [...document.querySelectorAll('button')].find(button => button.textContent === 'Checking postings 1/2');
        const cancel = [...document.querySelectorAll('button')].find(button => button.textContent === 'Cancel');
        assert(check?.disabled && cancel && !cancel.disabled);
      });
      await inspectSummary({ resultCount: 2, onRefreshOfficialPostings() {}, locked: true }, document => {
        assert(!document.body.textContent.includes('Refresh official postings'));
      });
    },
  },
  {
    name: 'Board actions remain disabled during official lookup without claiming a combine is running',
    async run() {
      for (const mode of ['lookup', 'combine', 'scan', 'idle']) {
        let recombines = 0;
        const label = mode === 'combine' ? 'Combining…' : mode === 'scan' ? 'Scanning…' : 'Re-combine';
        await inspectSummary({ onRecombine() { recombines++; }, onClear() {}, onRefreshOfficialPostings() {},
          combining: mode === 'combine', scanning: mode === 'scan', officialPostingRefreshing: mode === 'lookup',
          officialPostingProgress: { completed: 1, total: 2 } }, document => {
          const action = [...document.querySelectorAll('button')].find(button => button.textContent === label);
          const clear = [...document.querySelectorAll('button')].find(button => button.title.startsWith('Clear the combined board'));
          assert(action && clear);
          assert.equal(action.disabled, mode !== 'idle');
          assert.equal(clear.disabled, mode !== 'idle');
          action.click();
          assert.equal(recombines, mode === 'idle' ? 1 : 0);
          if (mode === 'lookup') {
            assert(document.body.textContent.includes('Checking postings 1/2'));
            assert(!document.body.textContent.includes('Combining…'));
            assert.equal(action.querySelector('.animate-spin'), null);
          }
        });
      }
    },
  },
  {
    name: 'Board card construction preserves the exact semantic lookup source and protected applications',
    run() {
      const source = { title: 'Synthetic Engineer', company: 'Synthetic Employer', location: 'Multiple locations',
        snippet: 'Synthetic original description.', description: 'Synthetic full description.', matchScore: 81,
        employer: 'Synthetic Employer', hiringOrganization: { name: 'Synthetic Employer' },
        locations: ['Synthetic City', 'Other Synthetic City'], workMode: 'remote', remote: true, remoteCountry: 'Canada', remoteRegion: '',
        employmentType: 'Full-time', seniority: 'Senior', jobLevel: 'Senior', identifier: 'synthetic-requisition',
        requisitionId: 'synthetic-requisition', reqId: 'synthetic-requisition', sourceUrl: 'https://listing.example.test/synthetic',
        provenance: 'synthetic-source', source: 'linkedin', url: 'https://listing.example.test/synthetic', salary: '',
        postingVariants: [{ location: 'Synthetic City', url: 'https://listing.example.test/one', source: 'linkedin' }],
        reuseCardId: 'synthetic-protected', officialPosting: { level: 'L5', outcome: 'not-found', employer: 'Synthetic Employer', trail: ['bridge-research'] } };
      const application = { id: 'synthetic-application', status: 'saved' };
      const tree = buildJobTreeNodes({ displayedJobs: [source], bucketTree: { likelihoodBands: [], salaryRanges: [],
        roles: [{ name: 'Engineering', jobIndices: [0] }] }, originalPos: { x: 0, y: 0 }, hubId: 'board', baseNodeId: 'source',
      protectedCards: [{ id: 'synthetic-protected', type: 'jobcard', data: { notes: 'Synthetic note', localApplication: application } }] });
      const card = tree.newNodes.find(node => node.type === 'jobcard');
      assert.equal(card.id, 'synthetic-protected'); assert.equal(card.data.localApplication, application);
      assert.equal(card.data.notes, 'Synthetic note');
      assert.equal(officialPostingPreparationSourceKey(projectOfficialPostingGenerationJob(card.data)),
        officialPostingPreparationSourceKey(projectOfficialPostingGenerationJob(source)));
    },
  },
  {
    name: 'Board result summary distinguishes 73 cards from 118 posting targets with 45 grouped location postings',
    async run() {
      await inspectSummary({ resultCount: 73, totalIncoming: 118, duplicatesRemoved: 0,
        locationPostingsCollapsed: 45, locationVariantGroups: 11 }, document => {
        assert.match(document.body.textContent, /73job cards/);
        assert.match(document.body.textContent, /118 posting targets collected · no duplicates/);
        assert.equal(document.querySelector('[data-summary="location-consolidation"]').textContent,
          '118 distinct posting targets · 45 additional location postings grouped in 11 groups');
        assert(!document.body.textContent.includes('unique jobs'));
      });
      const board = fs.readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      assert(board.includes('locationPostingsCollapsed={data.mergeStats?.locationVariantPostingsCollapsed}'));
      assert(board.includes('locationVariantGroups={data.mergeStats?.locationVariantGroups}'));
    },
  },
  {
    name: 'Legacy Board result summaries omit location grouping when no consolidation counts were saved',
    async run() {
      await inspectSummary({ resultCount: 4, totalIncoming: 6, duplicatesRemoved: 2 }, document => {
        assert.match(document.body.textContent, /4job cards/);
        assert.match(document.body.textContent, /6 posting targets collected · 2 duplicates removed/);
        assert.equal(document.querySelector('[data-summary="location-consolidation"]'), null);
        assert(!document.body.textContent.includes('undefined'));
      });
    },
  },
  {
    name: 'Board summary keeps preference exclusions separate from duplicate removals using real merge counters',
    async run() {
      const stats = {};
      const job = { title: 'Synthetic Engineer', company: 'Example', url: 'https://example.test/accepted' };
      const merged = unionScoredJobs([[job, { ...job }, { ...job, url: 'https://example.test/second' },
        { ...job, url: 'https://example.test/filtered', preferenceAssessment: { status: 'filtered' } }]], stats);
      assert.equal(stats.totalIncoming, 3, 'the merge counter excludes the preference-filtered row');
      assert.equal(stats.preferenceFilteredSkipped, 1);
      assert.equal(stats.duplicatesRemoved, 1);
      await inspectSummary({ resultCount: merged.length, ...stats }, document => {
        assert.match(document.body.textContent, /2job cards/);
        assert.match(document.body.textContent, /4 posting targets collected · 1 duplicate removed · 1 excluded by preferences/);
        assert.equal(document.querySelector('[data-summary="location-consolidation"]'), null);
        assert(!document.body.textContent.includes('exact duplicate'));
      });
      const board = fs.readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      assert(board.includes('preferenceFilteredSkipped={data.mergeStats?.preferenceFilteredSkipped}'));
    },
  },
  {
    name: 'Board summary reflects protected saved applications as separate cards while grouping only unprotected targets',
    async run() {
      const description = 'Design reliable scheduling services and inspect production delivery systems. '.repeat(12);
      const jobs = ['Toronto', 'Ottawa', 'Montreal'].map((location, index) => ({
        title: 'Synthetic Engineer', company: 'Example', location, snippet: description,
        url: `https://example.test/job/${index}`, matchScore: 80, source: 'dice',
        ...(index < 2 ? { cardId: `saved-${index}`, protected: true } : {}),
      }));
      const protectedCards = jobs.slice(0, 2).map((job, index) => ({
        id: job.cardId, type: 'jobcard', position: { x: 0, y: 0 },
        data: { ...job, hubId: 'board', localApplication: { id: `application-${index}`, status: 'saved' } },
      }));
      const attached = attachProtectedCards(jobs, protectedCards);
      const consolidated = consolidateJobLocations(attached.jobs, { protectedIds: new Set(protectedCards.map(card => card.id)) });
      assert.equal(consolidated.jobs.length, 2);
      assert.equal(consolidated.stats.postingsCollapsed, 1);
      const tree = buildJobTreeNodes({
        displayedJobs: consolidated.jobs,
        bucketTree: { likelihoodBands: [], salaryRanges: [], roles: [{ name: 'Engineering', jobIndices: [0, 1] }] },
        originalPos: { x: 0, y: 0 }, hubId: 'board', baseNodeId: 'summary', protectedCards,
      });
      const cards = tree.newNodes.filter(node => node.type === 'jobcard');
      assert.deepEqual(cards.map(card => card.id).sort(), ['saved-0', 'saved-1']);
      assert(cards.every(card => card.data.localApplication?.status === 'saved'));
      await inspectSummary({ resultCount: cards.length, totalIncoming: jobs.length,
        locationPostingsCollapsed: consolidated.stats.postingsCollapsed,
        locationVariantGroups: consolidated.stats.candidateGroups }, document => {
        assert.match(document.body.textContent, /2job cards/);
        assert.equal(document.querySelector('[data-summary="location-consolidation"]').textContent,
          '3 distinct posting targets · 1 additional location posting grouped in 1 group');
      });
    },
  },
  {
    name: 'Board result summary excludes malformed persisted location counts and hides old consolidation while stale',
    async run() {
      for (const invalid of ['45', -1, NaN, Infinity, 1.5]) {
        await inspectSummary({ resultCount: 73, totalIncoming: 118, locationPostingsCollapsed: invalid,
          locationVariantGroups: invalid }, document => {
          assert.equal(document.querySelector('[data-summary="location-consolidation"]'), null);
        });
      }
      await inspectSummary({ resultCount: 73, totalIncoming: 118, locationPostingsCollapsed: 45,
        locationVariantGroups: 11, stale: true }, document => {
        assert.equal(document.querySelector('[data-summary="location-consolidation"]'), null);
        assert.match(document.body.textContent, /Inputs changed/);
      });
    },
  },
];
