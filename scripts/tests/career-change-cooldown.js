import assert from 'node:assert/strict';
import { careerChangeLiftsCooldown, careerTextDifference, CAREER_CHANGE_RESCRAPE_THRESHOLD } from '../../src/utils/careerTextDifference.js';
import {
  buildSourceCoverageCommitPatch,
  careerCooldownComparisonPatch,
  jobSearchRescrapeAvailability,
  savedCareerDifferences,
  coolingCareerSnapshotIds,
  normalizeSourceCoverage,
  partitionSourcesByRescrapeAge,
  sourceCoverageCareerStampPatch,
} from '../../src/utils/jobSearchSourceCoverage.js';

const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);
const NOW = Date.UTC(2026, 10, 20, 12);
const HOUR = 60 * 60 * 1000;
const cooling = (careerSnapshotId) => ({
  careerSnapshotId: NEW,
  sourceCoverage: {
    indeed: { coverageStartedAt: NOW - 3 * HOUR, completedAt: NOW - 2 * HOUR, runId: 'run-1', ...(careerSnapshotId ? { careerSnapshotId } : {}) },
  },
});

export default [
  {
    name: 'career text difference: re-wrapping, case and moved sections barely count; small edits stay small; unrelated text is 1',
    run() {
      const para = i => `Led a team of engineers to deliver the payments platform migration for project ${i} improving reliability and reducing latency across regional services and partner integrations`;
      const base = [0, 1, 2, 3, 4, 5].map(para).join('\n');
      assert.equal(careerTextDifference(base, base), 0);
      const rewrapped = base.replace(/\n/g, ' ').replace(/(.{1,80})(\s|$)/g, '$1\n');
      assert.equal(careerTextDifference(base, rewrapped), 0, 're-wrapped paragraphs are the same text');
      assert.equal(careerTextDifference(base, base.toUpperCase()), 0);
      assert.ok(careerTextDifference(base, base.split('\n').reverse().join('\n')) < 0.05, 'moving sections changes only their edges');
      const edited = [0, 1, 2, 3, 4, 5].map(i => (i < 4 ? para(i).replace('a team', 'a large distributed team') : para(i))).join('\n');
      assert.ok(careerTextDifference(base, edited) < 0.1, 'a two-word edit in most paragraphs is a small change');
      const nurse = 'Registered nurse with eight years in pediatric intensive care, charge nurse duties, patient education, and electronic health record training for the hospital staff and residents';
      assert.equal(careerTextDifference(base, nurse), 1);
      const sameField = 'Managed a group of developers building the billing system rewrite, increasing uptime and cutting response time for internal tools and vendor APIs';
      assert.ok(careerTextDifference(para(0), sameField) > 0.9, 'shared common words do not make a new résumé look alike');
      const half = [0, 1, 2, 3, 4, 5].map(i => (i < 3 ? para(i) : nurse)).join('\n');
      const halfDifference = careerTextDifference(base, half);
      assert.ok(halfDifference > 0.4 && halfDifference < 0.6, `replacing half the text is about half different (${halfDifference})`);
      assert.equal(careerTextDifference('', ''), 0);
      assert.equal(CAREER_CHANGE_RESCRAPE_THRESHOLD, 0.5);
      assert.equal(careerChangeLiftsCooldown(0.5), false, 'exactly half is not more than half');
      assert.equal(careerChangeLiftsCooldown(0.51), true);
      assert.equal(careerChangeLiftsCooldown(null), false);
      assert.equal(careerChangeLiftsCooldown(NaN), false);
    },
  },
  {
    name: 'a cooling platform searched with career data more than 50% different is due; 50% or less, unknown, or the same data keeps the cooldown',
    run() {
      const lifted = partitionSourcesByRescrapeAge(cooling(OLD), ['indeed'], NOW, { careerDifferences: { [OLD]: 0.62 } });
      assert.deepEqual(lifted.due, ['indeed']);
      assert.deepEqual(lifted.fresh, []);
      assert.deepEqual(lifted.careerChanged, [{ sourceId: 'indeed', difference: 0.62 }]);

      for (const differences of [{ [OLD]: 0.5 }, { [OLD]: 0.3 }, { [OLD]: null }, {}, null]) {
        const kept = partitionSourcesByRescrapeAge(cooling(OLD), ['indeed'], NOW, { careerDifferences: differences });
        assert.deepEqual(kept.due, [], JSON.stringify(differences));
        assert.equal(kept.fresh.length, 1);
      }
      const legacy = partitionSourcesByRescrapeAge(cooling(null), ['indeed'], NOW, { careerDifferences: { [OLD]: 0.9 } });
      assert.equal(legacy.fresh.length, 1, 'a bookmark that never recorded its career data keeps its cooldown');
      const same = partitionSourcesByRescrapeAge(cooling(NEW), ['indeed'], NOW, { careerDifferences: { [NEW]: 0.9 } });
      assert.equal(same.fresh.length, 1, 'the same career data is never a change');
    },
  },
  {
    name: 'bookmarks record the career data a run searched with, keep it through normalisation, and list it for comparison',
    run() {
      const patch = buildSourceCoverageCommitPatch({ careerSnapshotId: NEW }, {
        runId: 'run-2', collectionStartedAt: NOW - HOUR, collectionCompletedAt: NOW,
        completedSourceIds: ['indeed'], careerSnapshotId: OLD,
      }, 'hub');
      assert.equal(patch.sourceCoverage.indeed.careerSnapshotId, OLD, "the run's own career data wins over the card's");
      const fallback = buildSourceCoverageCommitPatch({ careerSnapshotId: NEW }, {
        runId: 'run-3', collectionStartedAt: NOW - HOUR, collectionCompletedAt: NOW, completedSourceIds: ['indeed'],
      }, 'hub');
      assert.equal(fallback.sourceCoverage.indeed.careerSnapshotId, NEW);
      assert.equal(normalizeSourceCoverage({ indeed: { coverageStartedAt: NOW, careerSnapshotId: 'not-a-hash' } }).indeed.careerSnapshotId, undefined);
      assert.equal(normalizeSourceCoverage(cooling(OLD).sourceCoverage).indeed.careerSnapshotId, OLD);

      assert.deepEqual(coolingCareerSnapshotIds(cooling(OLD), ['indeed'], NOW), [OLD]);
      assert.deepEqual(coolingCareerSnapshotIds(cooling(NEW), ['indeed'], NOW), []);
      assert.deepEqual(coolingCareerSnapshotIds(cooling(OLD), ['indeed'], NOW + 25 * HOUR), [], 'nothing to compare once the cooldown is over');
      assert.deepEqual(coolingCareerSnapshotIds({ ...cooling(OLD), careerSnapshotId: null }, ['indeed'], NOW), []);
    },
  },
  {
    name: 'Clear writes the outgoing career data onto bookmarks that never recorded one, and leaves recorded ones alone',
    run() {
      const data = {
        careerSnapshotId: NEW,
        sourceCoverage: {
          indeed: { coverageStartedAt: NOW - HOUR, completedAt: NOW },
          linkedin: { coverageStartedAt: NOW - HOUR, completedAt: NOW, careerSnapshotId: OLD },
        },
      };
      const patch = sourceCoverageCareerStampPatch(data);
      assert.equal(patch.sourceCoverage.indeed.careerSnapshotId, NEW);
      assert.equal(patch.sourceCoverage.linkedin.careerSnapshotId, OLD);
      assert.deepEqual(sourceCoverageCareerStampPatch({ ...data, careerSnapshotId: null }), {});
      assert.deepEqual(sourceCoverageCareerStampPatch(patch), {}, 'nothing left to stamp');
    },
  },
  {
    name: "the card's saved comparison lifts the Board's cooldown check too, only for the career data it was measured against",
    run() {
      const data = { ...cooling(OLD), enabledSourceIds: ['indeed'] };
      assert.deepEqual(jobSearchRescrapeAvailability(data, NOW).due, [], 'no comparison saved: the Board sees the cooldown');
      const patch = careerCooldownComparisonPatch(data, NEW, { [OLD]: 0.7 });
      const compared = { ...data, ...patch };
      assert.deepEqual(jobSearchRescrapeAvailability(compared, NOW).due, ['indeed'], 'the Board starts the search the run will allow');
      assert.deepEqual(coolingCareerSnapshotIds(compared, null, NOW, { unsavedOnly: true }), [], 'a saved comparison is not measured again');
      assert.deepEqual(coolingCareerSnapshotIds(compared, null, NOW), [OLD]);
      assert.equal(careerCooldownComparisonPatch(data, OLD, { [OLD]: 0.7 }), null, 'a comparison for other career data is not saved');
      const replaced = { ...compared, careerSnapshotId: 'c'.repeat(64) };
      assert.deepEqual(savedCareerDifferences(replaced), {}, 'new career data voids the saved comparison');
      assert.deepEqual(savedCareerDifferences({ ...compared, careerCooldownComparison: { careerSnapshotId: NEW, differences: { [OLD]: 7 } } }), {});
      const unreadable = { ...data, ...careerCooldownComparisonPatch(data, NEW, { [OLD]: null }) };
      assert.deepEqual(jobSearchRescrapeAvailability(unreadable, NOW).due, [], 'an unreadable earlier version keeps the cooldown');
      assert.deepEqual(coolingCareerSnapshotIds(unreadable, null, NOW, { unsavedOnly: true }), [], 'and is not asked about again');
    },
  },
];
