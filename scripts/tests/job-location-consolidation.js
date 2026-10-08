import {
  consolidateJobLocations, consolidateBoardCascadeNodes, summarizeConsolidation,
  isConsolidationCandidate, descriptionFingerprint, buildPostingVariant,
  postingVariantKey, isSafeSourceUrl, MULTIPLE_LOCATIONS_LABEL, MIN_DESCRIPTION_ALNUM,
  isProtectedJobCard, emptyBoardCascadeStats, descriptionSimilarity,
  findSimilarLocationCandidates,
} from '../../src/utils/jobLocationConsolidation.js';
import { confirmSimilarJobLocationPairs } from '../../electron/ipc/jobLocationConsolidation.js';
import { migrateConsolidateBoardLocations, CURRENT_SCHEMA_VERSION } from '../../src/utils/serializationUtils.js';
import { buildJobTreeNodes } from '../../src/nodes/jobsearch/buildJobTree.js';
import { moduleFingerprint } from '../../src/nodes/jobboard/mergeJobs.js';
import { buildJobBoardDiagnostics } from '../../electron/ipc/bugReport/jobsSnapshot.js';
import { assert } from './testHelpers.js';

// A long, exact-description body. Reused verbatim so two postings fingerprint
// identically; any character-level change makes them a near-match non-merge.
const LONG_DESCRIPTION = `We are looking for a senior platform engineer to join the payments infrastructure team.
You will design, build, and operate distributed services that move money for millions of customers,
own reliability and observability, mentor engineers, and partner with product and security teams to
ship safe incremental changes. The role requires deep experience with Go or Java, Kubernetes, and
cloud networking, along with a track record of leading cross-team technical programs. You will be
expected to write design docs, review code, and drive measurable improvements to latency and cost.
Candidates should be comfortable operating production systems on call, debugging live incidents
under time pressure, and communicating clearly with both technical and non-technical partners.`;

// The same body with one wording change — similar but NOT an exact match.
const NEAR_MATCH_DESCRIPTION = LONG_DESCRIPTION.replace('payments infrastructure team', 'payments platform group');

function makeJob(overrides = {}) {
  return {
    title: 'Senior Platform Engineer',
    company: 'Affirm',
    url: 'https://jobs.example.com/affirm/senior-platform-engineer',
    description: LONG_DESCRIPTION,
    matchScore: 80,
    source: 'greenhouse',
    ...overrides,
  };
}

function affirmStyleFourLocation() {
  return [
    makeJob({ location: 'Remote - US', url: 'https://jobs.example.com/affirm/a', posted: '2026-02-01' }),
    makeJob({ location: 'New York, NY', url: 'https://jobs.example.com/affirm/b', posted: '2026-02-02' }),
    makeJob({ location: 'San Francisco, CA', url: 'https://jobs.example.com/affirm/c', posted: '2026-02-03' }),
    makeJob({ location: 'Remote - Canada', url: 'https://jobs.example.com/affirm/d', posted: '2026-02-04' }),
  ];
}

function snapshot(jobs) {
  return JSON.stringify(jobs);
}

export default [
  {
    name: 'consolidation: Affirm-style four-location exact-description postings collapse to one Multiple locations row',
    run: () => {
      const jobs = affirmStyleFourLocation();
      const { jobs: out, groups, stats } = consolidateJobLocations(jobs);
      assert(out.length === 1, `four same-description locations must collapse to one row, got ${out.length}`);
      assert(out[0].location === MULTIPLE_LOCATIONS_LABEL, `displayed location must be "${MULTIPLE_LOCATIONS_LABEL}"`);
      assert(groups.length === 1, 'exactly one consolidation group is reported');
      assert(stats.postingsCollapsed === 3, `three duplicate postings collapse, got ${stats.postingsCollapsed}`);
      assert(out[0].postingVariants.length === 4, `the bounded variant union holds all four postings, got ${out[0].postingVariants.length}`);
      const locations = out[0].postingVariants.map(v => v.location).sort();
      assert(JSON.stringify(locations) === JSON.stringify(['New York, NY', 'Remote - US', 'Remote - Canada', 'San Francisco, CA'].sort()),
        'every distinct posting location is represented in postingVariants');
      assert(out[0].consolidatedLocationCount === 4 && out[0].consolidatedPostingCount === 4,
        'consolidated location/posting counts reflect the four original postings');
      return { variants: out[0].postingVariants.length };
    },
  },
  {
    name: 'consolidation: input order is preserved and the inputs are never mutated',
    run: () => {
      const jobs = [
        makeJob({ location: 'Boston, MA', url: 'https://jobs.example.com/affirm/x1' }),
        { title: 'Data Analyst', company: 'Acme', location: 'Remote', description: 'short', matchScore: 50, url: 'https://jobs.example.com/acme/1' },
        makeJob({ location: 'Austin, TX', url: 'https://jobs.example.com/affirm/x2' }),
      ];
      const before = snapshot(jobs);
      const { jobs: out } = consolidateJobLocations(jobs);
      assert(snapshot(jobs) === before, 'consolidateJobLocations must not mutate its inputs');
      assert(out.length === 2, `two output rows expected, got ${out.length}`);
      assert(out[0].location === MULTIPLE_LOCATIONS_LABEL, 'the consolidated row keeps the first member position');
      assert(out[1].title === 'Data Analyst', 'an untouched non-candidate keeps its position after the consolidated row');
      return { rows: out.length };
    },
  },
  {
    name: 'consolidation: repeated consolidation is idempotent',
    run: () => {
      const first = consolidateJobLocations(affirmStyleFourLocation()).jobs;
      const firstSnapshot = snapshot(first);
      const second = consolidateJobLocations(first).jobs;
      assert(snapshot(second) === firstSnapshot, 're-running consolidation over its own output changes nothing');
      assert(second.length === 1, 'an already-consolidated row is not re-expanded');
      const third = consolidateJobLocations(second).jobs;
      assert(snapshot(third) === firstSnapshot, 'a third pass is still a fixed point');
      return { rows: second.length };
    },
  },
  {
    name: 'consolidation: different descriptions, same location, and short text never merge',
    run: () => {
      const differentDescription = [
        makeJob({ location: 'Remote - US', url: 'https://jobs.example.com/affirm/d1' }),
        makeJob({ location: 'New York, NY', description: NEAR_MATCH_DESCRIPTION, url: 'https://jobs.example.com/affirm/d2' }),
      ];
      const diffOut = consolidateJobLocations(differentDescription).jobs;
      assert(diffOut.length === 2, `a near-match description must not merge, got ${diffOut.length}`);

      const sameLocation = [
        makeJob({ location: 'Remote - US', url: 'https://jobs.example.com/affirm/s1' }),
        makeJob({ location: 'Remote - US', url: 'https://jobs.example.com/affirm/s2' }),
      ];
      const sameOut = consolidateJobLocations(sameLocation).jobs;
      assert(sameOut.length === 2, `same-location requisitions must not merge, got ${sameOut.length}`);

      const shortText = [
        makeJob({ location: 'Remote - US', description: 'Short snippet only.', url: 'https://jobs.example.com/affirm/t1' }),
        makeJob({ location: 'New York, NY', description: 'Short snippet only.', url: 'https://jobs.example.com/affirm/t2' }),
      ];
      const shortOut = consolidateJobLocations(shortText).jobs;
      assert(shortOut.length === 2, `short snippets below the ${MIN_DESCRIPTION_ALNUM}-char floor must not merge, got ${shortOut.length}`);

      const missingCompany = [
        makeJob({ company: '', location: 'Remote - US', url: 'https://jobs.example.com/affirm/m1' }),
        makeJob({ company: '', location: 'New York, NY', url: 'https://jobs.example.com/affirm/m2' }),
      ];
      assert(consolidateJobLocations(missingCompany).jobs.length === 2,
        'rows missing a normalized company must never merge');
      return { diffOut: diffOut.length, sameOut: sameOut.length, shortOut: shortOut.length };
    },
  },
  {
    name: 'consolidation: high deterministic similarity is only an AI-confirmable candidate, never an automatic merge',
    run: () => {
      const jobs = [
        makeJob({ location: 'Remote - US', url: 'https://jobs.example.com/affirm/similar-a' }),
        makeJob({ location: 'New York, NY', description: NEAR_MATCH_DESCRIPTION, url: 'https://jobs.example.com/affirm/similar-b' }),
      ];
      const similarity = descriptionSimilarity(jobs[0], jobs[1]);
      const candidates = findSimilarLocationCandidates(jobs);
      assert(similarity.score >= 0.75, `one harmless wording change should clear the deterministic gate, got ${similarity.score}`);
      assert(candidates.length === 1, `expected exactly one AI-confirmable pair, got ${candidates.length}`);
      assert(consolidateJobLocations(jobs).jobs.length === 2,
        'a high-similarity pair must remain separate until AI explicitly confirms it');
      const confirmed = consolidateJobLocations(jobs, { confirmedSimilarPairIds: [candidates[0].id] });
      assert(confirmed.jobs.length === 1 && confirmed.jobs[0].postingVariants.length === 2,
        'only the exact confirmed pair may collapse into a multi-location card');
      const filtered = [{ ...jobs[0], preferenceAssessment: { status: 'filtered' } }, jobs[1]];
      assert(findSimilarLocationCandidates(filtered).length === 0,
        'a preference-filtered result must never spend a confirmation call or participate in fuzzy consolidation');
      return { similarity: similarity.score, candidateId: candidates[0].id };
    },
  },
  {
    name: 'consolidation: AI confirmation batches use rolling shared-worker capacity and require exact pair coverage',
    run: async () => {
      const jobs = Array.from({ length: 6 }, (_, index) => makeJob({
        location: `City ${index}, ST`,
        url: `https://jobs.example.com/affirm/candidate-${index}`,
        description: LONG_DESCRIPTION.replace('payments infrastructure team', `payments infrastructure team variant${index}`),
      }));
      let active = 0;
      let peak = 0;
      const result = await confirmSimilarJobLocationPairs(jobs, {
        callText: async (prompt, options) => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise(resolve => setTimeout(resolve, 1));
          active -= 1;
          const confirmations = [...prompt.matchAll(/"pairId":"(\d+:\d+)"/g)]
            .map(match => ({ pairId: match[1], sameJob: true }));
          const response = { confirmations };
          options.responseValidator(response);
          return response;
        },
      });
      assert(result.candidateCount === 15 && result.batchCount === 4,
        `six near-identical locations should produce 15 pairs in four bounded batches, got ${JSON.stringify(result)}`);
      assert(result.confirmedPairIds.length === 15, 'each exact pair verdict should be retained');
      assert(peak > 1, 'independent confirmation batches must use available rolling worker capacity, not run serially');
      return { candidateCount: result.candidateCount, peak };
    },
  },
  {
    name: 'consolidation: URL union is bounded, deduplicated, and drops unsafe URLs',
    run: () => {
      const jobs = [
        makeJob({ location: 'Remote - US', url: 'https://jobs.example.com/affirm/a', applyUrl: 'https://apply.example.com/a' }),
        makeJob({ location: 'Remote - US', url: 'https://jobs.example.com/affirm/a' }), // duplicate variant
        makeJob({ location: 'New York, NY', url: 'javascript:alert(1)', googleCardUrl: 'https://g.example.com/ny' }),
        makeJob({ location: 'San Francisco, CA', url: 'https://user:pass@jobs.example.com/affirm/secret' }),
      ];
      const { jobs: out } = consolidateJobLocations(jobs);
      assert(out.length === 1, 'the cluster consolidates despite unsafe/duplicate URLs');
      const variants = out[0].postingVariants;
      const keys = variants.map(postingVariantKey);
      assert(new Set(keys).size === keys.length, 'variant union contains no duplicates');
      assert(!variants.some(v => v.url === 'javascript:alert(1)'), 'javascript: URLs are never retained');
      assert(!variants.some(v => v.url && v.url.includes('user:pass@')), 'credential-bearing URLs are never retained');
      assert(variants.some(v => v.googleCardUrl === 'https://g.example.com/ny'),
        'a safe source-facing URL is retained even when another field was unsafe');
      assert(isSafeSourceUrl('https://ok.example.com/x') && !isSafeSourceUrl('ftp://x') && !isSafeSourceUrl('data:text/html,x'),
        'the safe-URL predicate rejects non-http(s) and opaque schemes');
      const dense = [];
      for (let i = 0; i < 200; i += 1) {
        dense.push(makeJob({ location: `City ${i}`, url: `https://jobs.example.com/affirm/v${i}` }));
      }
      const bounded = consolidateJobLocations(dense).jobs[0].postingVariants;
      assert(bounded.length <= 64, `postingVariants must stay bounded, got ${bounded.length}`);
      return { variants: variants.length, bounded: bounded.length };
    },
  },
  {
    name: 'consolidation: zero or one protected card collapses and the protected card is reused',
    run: () => {
      const unprotected = affirmStyleFourLocation();
      const zero = consolidateJobLocations(unprotected).jobs;
      assert(zero.length === 1 && !zero[0].reuseCardId, 'a cluster with no protected card collapses to one fresh row');

      const state = { localApplication: { status: 'draft', appliedAt: '2026-01-01' } };
      const cardData = { ...affirmStyleFourLocation()[1], hubId: 'board-1' };
      const protectedRow = { ...cardData, cardId: 'card-protected', protected: true, cardData: { ...cardData, localApplication: state } };
      const withProtected = consolidateJobLocations(
        [affirmStyleFourLocation()[0], protectedRow, affirmStyleFourLocation()[2]],
        { protectedIds: new Set(['card-protected']) },
      );
      const out = withProtected.jobs;
      assert(out.length === 1, 'zero/one protected card yields a single consolidated row');
      assert(out[0].reuseCardId === 'card-protected', 'the protected card id is reused as the representative');
      assert(out[0].reuseCardData?.localApplication === state, 'the protected card persisted state travels with the reuse');
      assert(withProtected.stats.protectedRetained === 1, 'the protected-card count is reported');
      return { reuseCardId: out[0].reuseCardId };
    },
  },
  {
    name: 'consolidation: multiple protected cards all survive and only unprotected variants attach to one',
    run: () => {
      const stateA = { localApplication: { applicationId: 'app-a' } };
      const stateB = { localApplication: { applicationId: 'app-b' } };
      const base = affirmStyleFourLocation();
      const protectedA = { ...base[0], cardId: 'card-a', protected: true, cardData: { ...base[0], localApplication: stateA } };
      const protectedB = { ...base[1], cardId: 'card-b', protected: true, cardData: { ...base[1], localApplication: stateB } };
      const unprotected = [base[2], base[3]];
      const { jobs: out, stats } = consolidateJobLocations(
        [protectedA, protectedB, ...unprotected],
        { protectedIds: new Set(['card-a', 'card-b']) },
      );
      const ids = out.map(j => j.cardId).filter(Boolean);
      assert(out.length === 2, `two protected cards must both survive, got ${out.length}`);
      assert(ids.includes('card-a') && ids.includes('card-b'), 'both application-linked card ids remain present');
      const survivors = out.filter(j => j.cardId === 'card-a' || j.cardId === 'card-b');
      const representedLocations = new Set(survivors.flatMap(j => (j.postingVariants || [j]).map(v => v.location)));
      assert(survivors.some(j => j.postingVariants && j.postingVariants.length === 4),
        'the unprotected variants attach to exactly one protected card without dropping any');
      assert(representedLocations.size === 4,
        'every original location remains represented across the surviving protected cards');
      assert(stats.protectedRetained === 2, 'both protected cards are counted as retained');
      assert(stats.postingsCollapsed === 2, 'only the two unprotected duplicates are collapsed');
      return { survivors: survivors.length };
    },
  },
  {
    name: 'migration: version 10 consolidates a saved cascade, prunes emptied groups, and is idempotent',
    run: () => {
      assert(CURRENT_SCHEMA_VERSION === 10, `current schema version must be 10, got ${CURRENT_SCHEMA_VERSION}`);
      const base = affirmStyleFourLocation();
      const boardId = 'board-1';
      const nodes = [
        { id: boardId, type: 'jobboard', data: { hubState: 'done', resultCount: 4, finalSourceCounts: { greenhouse: 4 }, mergeStats: { removedDuplicates: 0 } } },
        { id: 'group-role', type: 'jobgroup', data: { hubId: boardId, kind: 'role', childIds: ['card-a', 'card-b', 'card-c', 'card-d'], count: 4 } },
        { id: 'group-remote', type: 'jobgroup', data: { hubId: boardId, kind: 'location', childIds: ['card-d'], count: 1 } },
        { id: 'card-a', type: 'jobcard', data: { ...base[0], hubId: boardId } },
        { id: 'card-b', type: 'jobcard', data: { ...base[1], hubId: boardId } },
        { id: 'card-c', type: 'jobcard', data: { ...base[2], hubId: boardId } },
        { id: 'card-d', type: 'jobcard', data: { ...base[3], hubId: boardId } },
      ];
      const nodesBefore = JSON.stringify(nodes);
      const { nodes: migrated, stats } = consolidateBoardCascadeNodes(nodes);
      assert(JSON.stringify(migrated) === JSON.stringify(migrateConsolidateBoardLocations(nodes)),
        'the version-10 wrapper delegates to the cascade consolidator');
      assert(JSON.stringify(nodes) === nodesBefore, 'the migration must not mutate its input array');

      const cards = migrated.filter(n => n.type === 'jobcard');
      assert(cards.length === 1, `four duplicate cards reduce to one, got ${cards.length}`);
      assert(cards[0].data.location === MULTIPLE_LOCATIONS_LABEL, 'the surviving card displays Multiple locations');
      assert(cards[0].data.postingVariants.length === 4, 'the surviving card persists its four variants');

      const group = migrated.find(n => n.id === 'group-role');
      assert(group, 'the non-empty parent group survives');
      assert(JSON.stringify(group.data.childIds) === JSON.stringify([cards[0].id]), `group childIds must point at the survivor, got ${JSON.stringify(group.data.childIds)}`);
      assert(group.data.count === 1, `recomputed group count must be 1, got ${group.data.count}`);
      assert(!migrated.some(n => n.id === 'group-remote'), 'a group emptied by consolidation is pruned');

      const board = migrated.find(n => n.type === 'jobboard');
      assert(board.data.resultCount === 1, `board resultCount must be recomputed to 1, got ${board.data.resultCount}`);
      assert(board.data.finalSourceCounts.greenhouse === 1, 'board source counts are recomputed from survivors');
      assert(board.data.mergeStats.locationVariantGroups === 1, 'mergeStats records one location-variant group');
      assert(board.data.mergeStats.locationVariantPostingsCollapsed === 3, 'mergeStats records three collapsed postings');
      assert(stats.postingsCollapsed === 3, `migration stats report three collapsed postings, got ${stats.postingsCollapsed}`);

      // Idempotence: a second run must be a structural no-op.
      const again = migrateConsolidateBoardLocations(migrated);
      assert(JSON.stringify(again) === JSON.stringify(migrated), 'a second migration pass changes nothing');

      // Nothing to consolidate → SAME array reference (no churn).
      const clean = [{ id: 'board-2', type: 'jobboard', data: {} }];
      assert(migrateConsolidateBoardLocations(clean) === clean, 'a cascade with nothing to merge returns the same array reference');
      const emptyStats = emptyBoardCascadeStats();
      assert(emptyStats.postingsCollapsed === 0 && emptyStats.eligibleGroups === 0, 'empty cascade stats are zeroed');
      return { survivors: cards.length };
    },
  },
  {
    name: 'migration: protected cards and localApplication state survive consolidation',
    run: () => {
      const base = affirmStyleFourLocation();
      const boardId = 'board-p';
      const state = { localApplication: { applicationId: 'app-keep', status: 'submitted' } };
      const nodes = [
        { id: boardId, type: 'jobboard', data: { hubState: 'done', resultCount: 4 } },
        { id: 'card-p', type: 'jobcard', data: { ...base[0], hubId: boardId, localApplication: state } },
        { id: 'card-x', type: 'jobcard', data: { ...base[1], hubId: boardId } },
        { id: 'card-y', type: 'jobcard', data: { ...base[2], hubId: boardId } },
      ];
      const migrated = migrateConsolidateBoardLocations(nodes);
      const survivor = migrated.find(n => n.type === 'jobcard');
      assert(survivor.id === 'card-p', `the application-linked card id must be reused, got ${survivor.id}`);
      assert(survivor.data.localApplication === state, 'the localApplication state is preserved verbatim');
      assert(isProtectedJobCard(survivor) === true, 'the survivor remains a protected card');
      return { survivor: survivor.id };
    },
  },
  {
    name: 'migration: multiple boards keep isolated stats and unrelated groups untouched',
    run: () => {
      const a = affirmStyleFourLocation().slice(0, 2);
      const b = affirmStyleFourLocation().slice(0, 3).map(job => ({
        ...job, title: 'Staff Backend Engineer', company: 'Example Co',
        url: job.url.replace('/affirm/', '/example/'),
      }));
      const unrelated = { id: 'unrelated-group', type: 'jobgroup', data: { hubId: 'other-board', childIds: [], count: 0 } };
      const nodes = [
        { id: 'board-a', type: 'jobboard', data: { resultCount: 2 } },
        { id: 'board-b', type: 'jobboard', data: { resultCount: 3 } },
        unrelated,
        ...a.map((job, index) => ({ id: `a-${index}`, type: 'jobcard', data: { ...job, hubId: 'board-a' } })),
        ...b.map((job, index) => ({ id: `b-${index}`, type: 'jobcard', data: { ...job, hubId: 'board-b' } })),
      ];
      const migrated = migrateConsolidateBoardLocations(nodes);
      const boardA = migrated.find(node => node.id === 'board-a');
      const boardB = migrated.find(node => node.id === 'board-b');
      assert(boardA.data.resultCount === 1 && boardA.data.mergeStats.locationVariantPostingsCollapsed === 1,
        'board A records only its own one collapsed posting');
      assert(boardB.data.resultCount === 1 && boardB.data.mergeStats.locationVariantPostingsCollapsed === 2,
        'board B records only its own two collapsed postings');
      assert(migrated.find(node => node.id === unrelated.id) === unrelated,
        'a job group owned by another board is preserved by reference');
      return { boardA: boardA.data.resultCount, boardB: boardB.data.resultCount };
    },
  },
  {
    name: 'tree: buildJobTreeNodes reuses protected ids/state and persists postingVariants with valid edges',
    run: () => {
      const base = affirmStyleFourLocation();
      const { jobs: consolidated } = consolidateJobLocations(base);
      const protectedNode = {
        id: 'card-protected', type: 'jobcard',
        data: { ...base[0], hubId: 'board-tree', localApplication: { applicationId: 'app-1' }, additionalNotes: 'keep me' },
      };
      const { jobs: withReuse } = consolidateJobLocations(base.map((j, i) => (
        i === 0 ? { ...j, cardId: 'card-protected', protected: true, cardData: protectedNode.data } : j
      )), { protectedIds: new Set(['card-protected']) });

      const built = buildJobTreeNodes({
        displayedJobs: withReuse,
        bucketTree: {
          roles: [{ name: 'Platform Engineering', jobIndices: withReuse.map((_, i) => i) }],
          likelihoodBands: [{ label: 'Strong (70-100%)', minScore: 70, maxScore: 100 }],
          salaryRanges: [{ label: '$120k+', minSalary: 120000, maxSalary: null }],
        },
        originalPos: { x: 0, y: 0 },
        hubId: 'board-tree',
        baseNodeId: 'base-tree',
        protectedCards: [protectedNode],
      });
      const card = built.newNodes.find(n => n.type === 'jobcard');
      assert(card, 'a jobcard node is produced');
      assert(card.id === 'card-protected', `the protected card id is reused in the tree, got ${card.id}`);
      assert(card.data.localApplication?.applicationId === 'app-1', 'localApplication survives into the reused card');
      assert(card.data.additionalNotes === 'keep me', 'additionalNotes survives into the reused card');
      assert(Array.isArray(card.data.postingVariants) && card.data.postingVariants.length === 4,
        'postingVariants are persisted on the card');

      const nodeIds = new Set([...built.newNodes.map(n => n.id), 'board-tree']);
      const dangling = built.newEdges.filter(e => !nodeIds.has(e.source) || !nodeIds.has(e.target));
      assert(dangling.length === 0, `every generated edge must reference a live node (or the hub), found ${dangling.length} dangling`);
      const reachable = new Set(built.newEdges.flatMap(e => [e.source, e.target]));
      assert(reachable.has('card-protected'), 'the reused card id is referenced by a generated edge');
      const declaredCards = built.newNodes.filter(n => n.type === 'jobcard').length;
      assert(declaredCards === 1 || built.taxonomy, 'the built tree is internally consistent');

      const rebuilt = buildJobTreeNodes({
        displayedJobs: [{ ...base[0], reuseCardId: 'card-protected' }],
        bucketTree: {
          roles: [{ name: 'Platform Engineering', jobIndices: [0] }],
          likelihoodBands: [{ label: 'Strong (70-100%)', minScore: 70, maxScore: 100 }],
          salaryRanges: [{ label: '$120k+', minSalary: 120000, maxSalary: null }],
        },
        originalPos: { x: 0, y: 0 }, hubId: 'board-tree', baseNodeId: 'base-tree-2',
        protectedCards: [{ ...protectedNode, data: { ...protectedNode.data, postingVariants: consolidated[0].postingVariants } }],
      });
      const rebuiltCard = rebuilt.newNodes.find(n => n.type === 'jobcard');
      assert(rebuiltCard.data.postingVariants === undefined,
        'reusing a protected card for a single posting clears stale consolidation metadata');
      return { cardId: card.id, edges: built.newEdges.length };
    },
  },
  {
    name: 'fingerprint: postingVariants deterministically change the module fingerprint',
    run: () => {
      const base = affirmStyleFourLocation();
      const plain = [makeJob({ location: 'Remote - US', url: 'https://jobs.example.com/affirm/p' })];
      const before = moduleFingerprint(plain);
      assert(moduleFingerprint(plain) === before, 'the fingerprint is stable for identical input');

      const consolidated = consolidateJobLocations(base).jobs;
      const withVariants = moduleFingerprint(consolidated);
      assert(withVariants !== before, 'a consolidated row with variants fingerprints differently from a plain row');

      const changed = consolidated.map(j => ({
        ...j,
        postingVariants: [...j.postingVariants.slice(0, 3), { ...j.postingVariants[3], location: 'Changed City' }],
      }));
      assert(moduleFingerprint(changed) !== withVariants, 'changing a variant location changes the fingerprint');
      assert(moduleFingerprint(consolidated) === withVariants, 'an unchanged consolidated row keeps its fingerprint');
      return { before, withVariants };
    },
  },
  {
    name: 'diagnostics: summarizeConsolidation is metadata-only (no titles, descriptions, URLs, locations, or fingerprints)',
    run: () => {
      const jobs = [
        ...affirmStyleFourLocation(),
        makeJob({ location: 'Remote - US', description: NEAR_MATCH_DESCRIPTION, url: 'https://jobs.example.com/affirm/near' }),
        { ...affirmStyleFourLocation()[0], location: 'Remote - US' },
      ];
      const facts = summarizeConsolidation(jobs);
      assert(facts.eligibleExactDescriptionMultiLocationGroups === 1,
        `exactly the Affirm cluster is eligible (near-match is excluded), got ${facts.eligibleExactDescriptionMultiLocationGroups}`);
      assert(facts.representedPostings === 0 && facts.alreadyConsolidated === 0, 'an unconsumed cluster reports zero consolidated rows');

      const serialized = JSON.stringify(facts);
      const forbidden = [
        'Senior Platform Engineer', 'Affirm', 'payments infrastructure', 'Remote - US',
        'New York', 'San Francisco', 'https://jobs.example.com', descriptionFingerprint(jobs[0]),
      ];
      for (const needle of forbidden) {
        assert(!serialized.includes(needle), `diagnostics must not leak "${needle.slice(0, 24)}"`);
      }
      for (const value of Object.values(facts)) {
        assert(typeof value === 'number', 'every diagnostic fact is a bare number, never a raw string');
      }

      const consolidated = consolidateJobLocations(jobs).jobs;
      const afterFacts = summarizeConsolidation(consolidated);
      assert(afterFacts.alreadyConsolidated === 1, 'an already-consolidated row is counted, not re-eligible');
      assert(afterFacts.representedPostings >= 4, 'the represented posting count reflects the variant union');
      return { facts };
    },
  },
  {
    name: 'diagnostics: Board report exposes accurate metadata-only migration facts',
    run: () => {
      const board = { id: 'board-report', type: 'jobboard', data: { hubState: 'done', resultCount: 4 } };
      const cards = affirmStyleFourLocation().map((job, index) => ({
        id: `report-${index}`, type: 'jobcard',
        data: { ...job, hubId: board.id, ...(index === 0 ? { localApplication: { applicationId: 'private-app' } } : {}) },
      }));
      const report = buildJobBoardDiagnostics([board, ...cards], []);
      assert(report.includes('eligible-exact-description-multi-location-groups=1'),
        'the diagnostic reports the eligible exact-description group');
      assert(report.includes('migration-postings-collapsed=3') && report.includes('migration-protected-retained=1'),
        'the diagnostic dry-run reports accurate collapse/protection counts');
      for (const secret of ['Senior Platform Engineer', 'Affirm', 'Remote - US', 'jobs.example.com', 'private-app']) {
        assert(!report.includes(secret), `the diagnostic must not leak ${secret}`);
      }
      return true;
    },
  },
  {
    name: 'guards: candidate predicate requires exact same normalized title/company and a full fingerprint',
    run: () => {
      const a = makeJob({ location: 'Remote - US' });
      const b = makeJob({ location: 'New York, NY' });
      assert(descriptionFingerprint(a) === descriptionFingerprint(b), 'identical descriptions fingerprint identically');

      assert(!isConsolidationCandidate({ ...a, description: 'too short' }), 'a short description is not a candidate');
      assert(!isConsolidationCandidate({ ...a, title: '' }), 'a missing title is not a candidate');
      assert(!isConsolidationCandidate({ ...a, company: '   ' }), 'a whitespace-only company is not a candidate');
      assert(isConsolidationCandidate(a), 'a full exact-description row is a candidate');

      const caseOnly = makeJob({ title: '  SENIOR   platform engineer ', company: 'AFFIRM', location: 'New York, NY' });
      assert(descriptionFingerprint(caseOnly) === descriptionFingerprint(a)
        && isConsolidationCandidate(caseOnly),
      'title/company normalization ignores case and surrounding whitespace');
      assert(buildPostingVariant(a).location === 'Remote - US', 'variant location preserves readable casing');
      return true;
    },
  },
];
