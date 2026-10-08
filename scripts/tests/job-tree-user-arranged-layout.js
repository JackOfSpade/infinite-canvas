import assert from 'node:assert';
import fs from 'node:fs';

import {
  JOB_TREE_LAYOUT_RESTORE_KEY,
  clearRestoredJobTreeLayout,
  computeJobTreeView,
  markJobTreeLayoutUserArranged,
} from '../../src/nodes/jobsearch/buildJobTree.js';

const readSource = (relative) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');

const card = (id, hubId, y, extra = {}) => ({
  id,
  type: 'jobcard',
  position: { x: 1400, y },
  measured: { height: 300 },
  data: { hubId, matchScore: 80 },
  ...extra,
});

const tree = () => [
  { id: 'hub', type: 'jobboard', position: { x: 0, y: 0 }, data: {} },
  { id: 'R', type: 'jobgroup', position: { x: 1000, y: 0 }, data: { hubId: 'hub', kind: 'role', expanded: true, childIds: ['c1', 'c2', 'c3'], visibleCount: 10 } },
  card('c1', 'hub', 0),
  card('c2', 'hub', 500),
  card('c3', 'hub', 910),
  { id: 'other-hub', type: 'jobboard', position: { x: 0, y: 3000 }, data: {} },
  card('o1', 'other-hub', 3000),
];

export default [
  {
    name: 'markJobTreeLayoutUserArranged flags only the named hub\'s job cards and never mutates its input',
    run: async () => {
      const nodes = tree();
      const snapshot = JSON.stringify(nodes);
      const out = markJobTreeLayoutUserArranged(nodes, 'hub');
      assert(out !== nodes, 'a new array is returned when cards were flagged');
      assert(JSON.stringify(nodes) === snapshot, 'input array and nodes are not mutated');
      for (const id of ['c1', 'c2', 'c3']) {
        assert(out.find((n) => n.id === id).data[JOB_TREE_LAYOUT_RESTORE_KEY], `${id} is flagged`);
      }
      for (const id of ['hub', 'R', 'other-hub', 'o1']) {
        assert(out.find((n) => n.id === id) === nodes.find((n) => n.id === id), `${id} keeps its identity`);
      }
      assert(out.find((n) => n.id === 'c1').position === nodes.find((n) => n.id === 'c1').position, 'positions are carried through untouched');
    },
  },
  {
    name: 'markJobTreeLayoutUserArranged is a same-reference no-op when idempotent, hubless, or given a non-array',
    run: async () => {
      const marked = markJobTreeLayoutUserArranged(tree(), 'hub');
      assert(markJobTreeLayoutUserArranged(marked, 'hub') === marked, 'second call returns the same array');
      const nodes = tree();
      assert(markJobTreeLayoutUserArranged(nodes, '') === nodes, 'empty hubId is a no-op');
      assert(markJobTreeLayoutUserArranged(nodes, null) === nodes, 'null hubId is a no-op');
      assert(markJobTreeLayoutUserArranged(nodes, 'no-such-hub') === nodes, 'a hub with no cards is a no-op');
      assert(markJobTreeLayoutUserArranged(undefined, 'hub') === undefined, 'undefined input is returned as-is');
      assert(markJobTreeLayoutUserArranged(null, 'hub') === null, 'null input is returned as-is');
      const notArray = { id: 'x' };
      assert(markJobTreeLayoutUserArranged(notArray, 'hub') === notArray, 'a non-array is returned as-is');
    },
  },
  {
    name: 'the next explicit hierarchy action clears the mark from exactly the flagged cards',
    run: async () => {
      const nodes = tree();
      const marked = markJobTreeLayoutUserArranged(nodes, 'hub');
      const cleared = clearRestoredJobTreeLayout(marked, 'hub');
      for (const id of ['c1', 'c2', 'c3']) {
        assert(!(JOB_TREE_LAYOUT_RESTORE_KEY in cleared.find((n) => n.id === id).data), `${id} is unflagged again`);
      }
      assert(cleared.find((n) => n.id === 'o1') === nodes.find((n) => n.id === 'o1'), 'other hub cards stay untouched');
      // Only the named hub is cleared.
      const both = markJobTreeLayoutUserArranged(markJobTreeLayoutUserArranged(nodes, 'hub'), 'other-hub');
      const clearedHub = clearRestoredJobTreeLayout(both, 'hub');
      assert(clearedHub.find((n) => n.id === 'o1').data[JOB_TREE_LAYOUT_RESTORE_KEY], 'other hub keeps its mark');
    },
  },
  {
    name: 'marking changes no positions, while an unflagged tree still reflows when forced',
    run: async () => {
      const nodes = tree();
      const marked = markJobTreeLayoutUserArranged(nodes, 'hub');
      assert(marked.every((n, i) => n.position === nodes[i].position), 'marking leaves every position untouched');
      // The reflow itself is skipped by JobCardNode's effect while the flag is
      // present; without the flag, a forced reflow does re-lay-out the cards.
      const reflowed = computeJobTreeView(clearRestoredJobTreeLayout(marked, 'hub'), 'hub', {}, undefined, true);
      const moved = ['c1', 'c2', 'c3'].some((id) => reflowed.find((n) => n.id === id).position.y !== nodes.find((n) => n.id === id).position.y);
      assert(moved, 'the deterministic layout replaces off-grid positions when not preserved');
    },
  },
  {
    name: 'drag stop marks the dragged job card\'s hub on the ordinary path and the card effect still honours the flag',
    run: async () => {
      const hook = readSource('../../src/hooks/useDragCorrections.js');
      assert(/import \{ markJobTreeLayoutUserArranged \} from '\.\.\/nodes\/jobsearch\/buildJobTree'/.test(hook), 'hook imports the helper');
      const stopStart = hook.indexOf('const onNodeDragStop = useCallback(');
      const callAt = hook.indexOf('markJobTreeLayoutUserArranged(nds, hubId)', stopStart);
      const rejectedAt = hook.indexOf('Rejected non-file node drop', stopStart);
      const snapshotAt = hook.lastIndexOf('if (takeSnapshot) takeSnapshot();');
      assert(stopStart !== -1 && callAt !== -1, 'helper is called inside onNodeDragStop');
      assert(rejectedAt !== -1 && rejectedAt < callAt, 'the mark runs after the rejected-hub-drop early return');
      assert(callAt < snapshotAt, 'the mark runs before the final undo snapshot');
      const cardSource = readSource('../../src/nodes/JobCardNode.jsx');
      assert(cardSource.includes('if (preserveTreeLayoutOnRestore) return;'), 'JobCardNode still skips the measured reflow while flagged');
    },
  },
];
