import assert from 'node:assert/strict';
import { bundleComponent, withDom } from './fixtures/handoff-bridge/mountComponent.js';
import {
  COL_X,
  computeJobTreeView,
  computeLayoutPositions,
  countMatchingDescendantCards,
  normalizeJobGroupVisibleCount,
  normalizeRangesWithRepairs,
} from '../../src/nodes/jobsearch/buildJobTree.js';

const group = (id, hubId, childIds, extra = {}) => ({
  id, type: 'jobgroup', position: { x: 0, y: 0 }, hidden: true,
  data: { hubId, kind: 'role', expanded: true, childIds, ...extra },
});
const card = (id, hubId, extra = {}) => ({
  id, type: 'jobcard', position: { x: 900, y: 900 }, hidden: true,
  data: { hubId, source: 'dice', matchScore: 80, ...extra },
});

export default [
  {
    name: 'Job clear confirmation requires fresh clicks after unlocking and rejects expired confirmations before timers run',
    async run() {
      const bundle = await bundleComponent('src/nodes/jobsearch/TwoStepConfirmButton.jsx');
      try {
        await withDom(async window => {
          const { React, createRoot, act, TwoStepConfirmButton } = bundle.module;
          const root = createRoot(window.document.getElementById('root'));
          let confirmed = 0;
          const render = disabled => act(async () => root.render(React.createElement(TwoStepConfirmButton, {
            label: 'Clear jobs', confirmLabel: 'Confirm clear', disabled,
            onConfirm: () => confirmed++, timeoutMs: 4000,
          })));
          const click = () => act(async () => window.document.querySelector('button').click());
          const now = Date.now;
          try {
            await render(false);
            await click();
            assert.equal(window.document.querySelector('button').textContent, 'Confirm clear');
            await render(true);
            await render(false);
            assert.equal(window.document.querySelector('button').textContent, 'Clear jobs');
            await click();
            assert.equal(confirmed, 0, 'unlocking must invalidate the prior confirmation');
            await click();
            assert.equal(confirmed, 1);
            await click();
            const afterDeadline = now() + 5000;
            Date.now = () => afterDeadline;
            await click();
            assert.equal(confirmed, 1, 'a delayed timeout cannot leave a destructive action armed');
            await click();
            assert.equal(confirmed, 2, 'the rearmed action still accepts two fresh clicks');
          } finally {
            Date.now = now;
            await act(async () => root.unmount());
          }
        });
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'Job tree traversal never counts, moves, or expands nodes owned by another board',
    run() {
      const foreign = { ...card('foreign-card', 'other'), hidden: false };
      const nodes = [
        { id: 'hub', position: { x: 10, y: 20 }, data: {} },
        group('root', 'hub', ['own-card', 'foreign-card', 'foreign-group']),
        card('own-card', 'hub'),
        foreign,
        { ...group('foreign-group', 'other', ['indirect-card']), hidden: false },
        card('indirect-card', 'hub'),
      ];
      const byId = new Map(nodes.map(node => [node.id, node]));
      assert.equal(countMatchingDescendantCards(['root'], id => byId.get(id), {}, 'hub'), 1);
      const output = computeJobTreeView(nodes, 'hub');
      assert.equal(output.find(node => node.id === 'foreign-card'), foreign, 'other boards retain their exact node object');
      assert.equal(output.find(node => node.id === 'foreign-group'), nodes[4]);
      assert.equal(output.find(node => node.id === 'indirect-card').hidden, false, 'a foreign group cannot claim a local standalone card');
      const positions = computeLayoutPositions(output, 'hub', COL_X, { x: 10, y: 20 });
      assert.equal(positions['foreign-card'], undefined);
      assert.equal(positions['foreign-group'], undefined);
    },
  },
  {
    name: 'Job tree pagination repairs malformed counts, ignores duplicate child IDs, and tolerates malformed child lists',
    run() {
      for (const value of [-1, Infinity, NaN, 2.5, '20', undefined]) {
        assert.equal(normalizeJobGroupVisibleCount(value), 10);
        const ids = Array.from({ length: 15 }, (_, index) => `card-${index}`);
        const nodes = [group('root', 'hub', [ids[0], ids[0], ...ids.slice(1)], { visibleCount: value }),
          ...ids.map(id => card(id, 'hub'))];
        const output = computeJobTreeView(nodes, 'hub');
        assert.equal(output.filter(node => node.type === 'jobcard' && !node.hidden).length, 10);
      }
      assert.equal(normalizeJobGroupVisibleCount(0), 0);
      assert.doesNotThrow(() => computeJobTreeView([group('root', 'hub', { broken: true })], 'hub'));
      const mixed = [group('root', 'hub', ['direct', 'nested']), group('nested', 'hub', ['inside']),
        card('direct', 'hub'), card('inside', 'hub')];
      const output = computeJobTreeView(mixed, 'hub');
      assert(output.filter(node => node.type === 'jobcard').every(node => !node.hidden), 'mixed saved branches retain reachable cards');
    },
  },
  {
    name: 'Job salary range repair emits only finite bounds for non-finite saved values',
    run() {
      const result = normalizeRangesWithRepairs([
        { minSalary: Infinity, maxSalary: 0 },
        { minSalary: 80000, maxSalary: Infinity },
        { minSalary: -Infinity, maxSalary: NaN },
      ]);
      assert(result.real.length > 0);
      assert([...result.real, result.unspecified].every(range => Number.isFinite(range.minSalary) && Number.isFinite(range.maxSalary)));
      assert(result.repairs.includes('repaired non-numeric salary bound'));
      assert(!JSON.stringify(result).includes('Infinity'));
    },
  },
];
