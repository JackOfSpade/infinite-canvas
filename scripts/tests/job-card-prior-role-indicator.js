import assert from 'node:assert';
import { priorRoleIndicator, PRIOR_ROLE_TONE, priorRoleDocuments, bundleDeletionPatches } from '../../src/utils/jobCardPriorRoleIndicator.js';

const prior = {
  id: 'job-1',
  canvasFilePath: '/project/canvas.json',
  savedDir: '/project/Applied Jobs/Acme/Role',
  appliedAt: '2026-10-28T04:15:07.478Z',
  company: 'Acme',
  title: 'Engineer',
  location: 'Toronto, Ontario, Canada',
  listingUrl: 'https://example.com/old',
};

export default [
  {
    name: 'priorRoleDocuments returns the pointer savedDocuments as a copy',
    run() {
      const savedDocuments = { resume: true, cover: false };
      const docs = priorRoleDocuments({ priorRoleApplication: { ...prior, savedDocuments } });
      assert.deepStrictEqual(docs, { resume: true, cover: false });
      assert.notStrictEqual(docs, savedDocuments);
      assert.deepStrictEqual(priorRoleDocuments({ priorRoleApplication: { ...prior, savedDocuments: { resume: false, cover: true } } }), { resume: false, cover: true });
    },
  },
  {
    name: 'priorRoleDocuments assumes both documents without a usable record',
    run() {
      assert.deepStrictEqual(priorRoleDocuments({ priorRoleApplication: prior }), { resume: true, cover: true });
      for (const savedDocuments of [{ resume: true }, { resume: 'yes', cover: true }, null, 'x']) {
        assert.deepStrictEqual(priorRoleDocuments({ priorRoleApplication: { ...prior, savedDocuments } }), { resume: true, cover: true }, JSON.stringify(savedDocuments));
      }
    },
  },
  {
    name: 'priorRoleDocuments is empty for malformed pointers',
    run() {
      const cases = [
        undefined, null, 'x', [], {}, { priorRoleApplication: null }, { priorRoleApplication: 'job-1' },
        { priorRoleApplication: [prior] },
        { priorRoleApplication: { ...prior, id: '' } },
        { priorRoleApplication: { ...prior, id: 4 } },
        { priorRoleApplication: { ...prior, savedDir: '' } },
        { priorRoleApplication: { ...prior, savedDir: undefined } },
      ];
      for (const input of cases) assert.deepStrictEqual(priorRoleDocuments(input), { resume: false, cover: false }, JSON.stringify(input));
    },
  },
  {
    name: 'priorRoleDocuments still counts documents when the card owns a saved bundle',
    run() {
      const docs = priorRoleDocuments({ priorRoleApplication: prior, localApplication: { id: 'x', status: 'saved' } });
      assert.deepStrictEqual(docs, { resume: true, cover: true });
    },
  },
  {
    name: 'bundleDeletionPatches clears own and prior-saved references',
    run() {
      const nodes = [
        { id: 'own', type: 'jobcard', data: { localApplication: { id: 'job-1' }, priorSavedApplication: { id: 'job-1' } } },
        { id: 'prior', type: 'jobcard', data: { priorSavedApplication: { id: 'job-1' }, localApplication: { id: 'other' } } },
        { id: 'other', type: 'jobcard', data: { localApplication: { id: 'job-2' } } },
        { id: 'note', type: 'note', data: { localApplication: { id: 'job-1' }, priorRoleApplication: { id: 'job-1' } } },
        { id: 'bare', type: 'jobcard', data: {} },
      ];
      assert.deepStrictEqual(bundleDeletionPatches(nodes, 'job-1'), [
        { id: 'own', patch: { localApplication: null, priorSavedApplication: null } },
        { id: 'prior', patch: { priorSavedApplication: null } },
      ]);
    },
  },
  {
    name: 'bundleDeletionPatches merges a prior-role match with an own match per node',
    run() {
      const nodes = [
        { id: 'a', type: 'jobcard', data: { localApplication: { id: 'job-1' }, priorRoleApplication: { id: 'job-1' } } },
        { id: 'repost', type: 'jobcard', data: { priorRoleApplication: { id: 'job-1' } } },
        { id: 'elsewhere', type: 'jobcard', data: { priorRoleApplication: { id: 'job-9' } } },
      ];
      assert.deepStrictEqual(bundleDeletionPatches(nodes, 'job-1'), [
        { id: 'a', patch: { localApplication: null, priorSavedApplication: null, priorRoleApplication: null } },
        { id: 'repost', patch: { priorRoleApplication: null } },
      ]);
    },
  },
  {
    name: 'bundleDeletionPatches ignores an empty or non-string jobId',
    run() {
      const nodes = [{ id: 'a', type: 'jobcard', data: { localApplication: { id: '' }, priorRoleApplication: { id: undefined } } }];
      for (const jobId of ['', undefined, null, 5]) assert.deepStrictEqual(bundleDeletionPatches(nodes, jobId), [], String(jobId));
    },
  },
  {
    name: 'priorRoleIndicator returns null for missing or malformed pointers',
    run() {
      const cases = [
        undefined, null, 'x', [],
        {}, { priorRoleApplication: null }, { priorRoleApplication: 'job-1' },
        { priorRoleApplication: [prior] },
        { priorRoleApplication: { ...prior, id: undefined } },
        { priorRoleApplication: { ...prior, id: '' } },
        { priorRoleApplication: { ...prior, savedDir: undefined } },
        { priorRoleApplication: { ...prior, savedDir: '' } },
        { priorRoleApplication: { ...prior, savedDir: 7 } },
      ];
      for (const input of cases) assert.strictEqual(priorRoleIndicator(input), null, JSON.stringify(input));
    },
  },
  {
    name: 'priorRoleIndicator is null when the card owns a saved bundle',
    run() {
      assert.strictEqual(priorRoleIndicator({ priorRoleApplication: prior, localApplication: { id: 'x', status: 'saved' } }), null);
      assert.notStrictEqual(priorRoleIndicator({ priorRoleApplication: prior, localApplication: { id: 'x', status: 'queued' } }), null);
    },
  },
  {
    name: 'priorRoleIndicator reports label and exact detail for a full pointer',
    run() {
      const indicator = priorRoleIndicator({ priorRoleApplication: prior });
      assert.strictEqual(indicator.label, 'Applied to this role before');
      assert.strictEqual(indicator.detail, 'Applied Oct 28, 2026 · Toronto, Ontario, Canada');
    },
  },
  {
    name: 'priorRoleIndicator falls back to "Applied earlier" for missing or invalid dates',
    run() {
      for (const appliedAt of ['not-a-date', undefined, '']) {
        const indicator = priorRoleIndicator({ priorRoleApplication: { ...prior, appliedAt } });
        assert.strictEqual(indicator.detail, 'Applied earlier · Toronto, Ontario, Canada', String(appliedAt));
      }
      assert.strictEqual(priorRoleIndicator({ priorRoleApplication: { ...prior, appliedAt: 'bad', location: '' } }).detail, 'Applied earlier');
    },
  },
  {
    name: 'priorRoleIndicator omits the location separator when location is empty',
    run() {
      for (const location of ['', undefined]) {
        const { detail } = priorRoleIndicator({ priorRoleApplication: { ...prior, location } });
        assert.strictEqual(detail, 'Applied Oct 28, 2026');
        assert.ok(!detail.includes(' · '));
      }
    },
  },
  {
    name: 'priorRoleIndicator title explains the reposted listing and names the folder',
    run() {
      const { title } = priorRoleIndicator({ priorRoleApplication: prior });
      assert.ok(title.includes(prior.savedDir));
      assert.ok(/different listing/.test(title) && /résumé and cover letter/.test(title));
    },
  },
  {
    name: 'PRIOR_ROLE_TONE is a frozen sky palette distinct from red, emerald and amber',
    run() {
      assert.strictEqual(Object.isFrozen(PRIOR_ROLE_TONE), true);
      assert.ok(/sky-|cyan-/.test(PRIOR_ROLE_TONE.badge));
      for (const banned of ['red-', 'emerald-', 'amber-']) assert.ok(!PRIOR_ROLE_TONE.badge.includes(banned), banned);
    },
  },
];
