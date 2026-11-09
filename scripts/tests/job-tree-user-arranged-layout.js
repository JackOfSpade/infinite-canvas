import assert from 'node:assert';
import fs from 'node:fs';

import {
  COL_X,
  JOB_CARD_USER_POSITION_KEY,
  JOB_TREE_LAYOUT_RESTORE_KEY,
  clearRestoredJobTreeLayout,
  computeJobTreeView,
  computeLayoutPositions,
  markJobCardsUserPositioned,
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
  {
    name: 'markJobCardsUserPositioned marks only the listed job cards and never mutates its input',
    run: async () => {
      const nodes = tree();
      const snapshot = JSON.stringify(nodes);
      const out = markJobCardsUserPositioned(nodes, ['c2']);
      assert(out !== nodes, 'a new array is returned when a card was marked');
      assert(JSON.stringify(nodes) === snapshot, 'input array and nodes are not mutated');
      assert.strictEqual(out.find((n) => n.id === 'c2').data[JOB_CARD_USER_POSITION_KEY], true, 'c2 is marked');
      for (const id of ['c1', 'c3', 'hub', 'R', 'other-hub', 'o1']) {
        assert(out.find((n) => n.id === id) === nodes.find((n) => n.id === id), `${id} keeps its identity`);
        assert(!(JOB_CARD_USER_POSITION_KEY in out.find((n) => n.id === id).data), `${id} is not marked`);
      }
      assert(out.find((n) => n.id === 'c2').position === nodes.find((n) => n.id === 'c2').position, 'the position object is carried through untouched');
      // The mark is a card field: a group or hub id in the list marks nothing.
      assert(markJobCardsUserPositioned(nodes, ['R', 'hub']) === nodes, 'group/hub ids mark nothing and stay a no-op');
      assert(markJobCardsUserPositioned(nodes, ['c2', 'o1']).find((n) => n.id === 'o1').data[JOB_CARD_USER_POSITION_KEY] === true, 'listed cards across hubs are marked');
    },
  },
  {
    name: 'markJobCardsUserPositioned is a same-reference no-op when nothing changes',
    run: async () => {
      const marked = markJobCardsUserPositioned(tree(), ['c2']);
      assert(markJobCardsUserPositioned(marked, ['c2']) === marked, 're-marking a marked card returns the same array');
      assert(markJobCardsUserPositioned(marked, new Set(['c2'])) === marked, 'an already-marked id in a Set is a no-op');
      const nodes = tree();
      assert(markJobCardsUserPositioned(nodes, []) === nodes, 'an empty id list is a no-op');
      assert(markJobCardsUserPositioned(nodes, new Set()) === nodes, 'an empty Set is a no-op');
      assert(markJobCardsUserPositioned(nodes, ['no-such-card']) === nodes, 'an unknown id is a no-op');
      assert(markJobCardsUserPositioned(nodes, undefined) === nodes, 'a missing id collection is a no-op');
      assert(markJobCardsUserPositioned(undefined, ['c2']) === undefined, 'undefined input is returned as-is');
      assert(markJobCardsUserPositioned(null, ['c2']) === null, 'null input is returned as-is');
      const notArray = { id: 'x' };
      assert(markJobCardsUserPositioned(notArray, ['c2']) === notArray, 'a non-array is returned as-is');
    },
  },
  {
    name: 'computeLayoutPositions gives a user-positioned card no slot and no vertical space',
    run: async () => {
      const nodes = tree();
      const hubPos = { x: 0, y: 0 };
      const before = computeLayoutPositions(nodes, 'hub', COL_X, hubPos);
      assert.deepStrictEqual(before.c2, { x: 1400, y: 340 }, 'the unmarked layout still stacks c2 under c1');
      const marked = markJobCardsUserPositioned(nodes, ['c2']);
      const after = computeLayoutPositions(marked, 'hub', COL_X, hubPos);
      assert(!('c2' in after), 'a user-positioned card gets no entry in the positions map');
      assert.deepStrictEqual(after.c1, before.c1, 'the card above keeps its slot');
      assert.strictEqual(after.c3.y, before.c2.y, 'c3 closes the gap and takes the slot c2 used to hold');
      assert.notStrictEqual(after.c3.y, before.c3.y, 'the unmarked layout would have left c3 further down');
      assert.deepStrictEqual(after.R, before.R, 'groups are laid out exactly as before');
      // The Combine builder seeds a reused card with reuse.position and only
      // writes positions the map contains, so the mark keeps that position.
      const seeded = marked.map((n) => ({ ...n, position: n.id === 'c2' ? { x: 2154, y: 500 } : { x: -1, y: -1 } }));
      const layoutPos = computeLayoutPositions(seeded, 'hub', COL_X, hubPos);
      seeded.forEach((n) => { if (layoutPos[n.id]) n.position = layoutPos[n.id]; });
      assert.deepStrictEqual(seeded.find((n) => n.id === 'c2').position, { x: 2154, y: 500 }, 'a reused marked card keeps reuse.position');
      assert.strictEqual(seeded.find((n) => n.id === 'c3').position.y, before.c2.y, 'the builder pass still tightens the column');
    },
  },
  {
    name: 'a forced reflow keeps a marked card exactly where it was dropped and keeps its mark',
    run: async () => {
      const dropped = markJobCardsUserPositioned(tree(), ['c2'])
        .map((n) => (n.id === 'c2' ? { ...n, position: { x: 2154, y: 500 } } : n));
      const baseline = computeJobTreeView(tree(), 'hub', {}, undefined, true);
      const vacatedY = baseline.find((n) => n.id === 'c2').position.y;
      const reflowed = computeJobTreeView(dropped, 'hub', {}, undefined, true);
      const c2 = reflowed.find((n) => n.id === 'c2');
      assert.deepStrictEqual(c2.position, { x: 2154, y: 500 }, 'c2 keeps its exact dropped position');
      assert.strictEqual(c2.data[JOB_CARD_USER_POSITION_KEY], true, 'the mark survives the reflow');
      assert.strictEqual(reflowed.find((n) => n.id === 'c3').position.y, vacatedY, 'c3 moves up to where c2 used to sit');
      assert.notStrictEqual(reflowed.find((n) => n.id === 'c3').position.y, baseline.find((n) => n.id === 'c3').position.y, 'c3 is not left in its re-stacked slot');
    },
  },
  {
    name: 'a group expand (clearRestoredJobTreeLayout then relayout) no longer snaps a placed card back',
    run: async () => {
      const dropped = markJobCardsUserPositioned(tree(), ['c2'])
        .map((n) => (n.id === 'c2' ? { ...n, position: { x: 2154, y: 500 } } : n));
      const vacatedY = computeJobTreeView(tree(), 'hub', {}, undefined, true).find((n) => n.id === 'c2').position.y;
      // What an ordinary drop leaves behind before the hierarchy action.
      const guarded = markJobTreeLayoutUserArranged(dropped, 'hub');
      const cleared = clearRestoredJobTreeLayout(guarded, 'hub');
      const clearedC2 = cleared.find((n) => n.id === 'c2');
      assert.strictEqual(clearedC2.data[JOB_CARD_USER_POSITION_KEY], true, 'clearing the restore guard keeps the user-positioned mark');
      assert(!(JOB_TREE_LAYOUT_RESTORE_KEY in clearedC2.data), 'the board-wide guard is gone');
      const after = computeJobTreeView(cleared, 'hub', {}, undefined, true);
      const c2 = after.find((n) => n.id === 'c2');
      assert.deepStrictEqual(c2.position, { x: 2154, y: 500 }, 'c2 still keeps its dropped position');
      assert.strictEqual(c2.data[JOB_CARD_USER_POSITION_KEY], true, 'the mark is still recorded');
      assert.strictEqual(after.find((n) => n.id === 'c3').position.y, vacatedY, 'the gap below c2 stays closed');
    },
  },
  {
    name: 'drag stop marks the dropped job cards themselves as user-positioned',
    run: async () => {
      const hook = readSource('../../src/hooks/useDragCorrections.js');
      assert(/import \{ markJobCardsUserPositioned \} from '\.\.\/nodes\/jobsearch\/buildJobTree'/.test(hook), 'hook imports the per-card helper');
      assert(/import \{ markJobTreeLayoutUserArranged \} from '\.\.\/nodes\/jobsearch\/buildJobTree'/.test(hook), 'the existing board-wide import is kept');
      const stopStart = hook.indexOf('const onNodeDragStop = useCallback(');
      const callAt = hook.indexOf('markJobCardsUserPositioned(nds, placedCardIds)', stopStart);
      const rejectedAt = hook.indexOf('Rejected non-file node drop', stopStart);
      const snapshotAt = hook.lastIndexOf('if (takeSnapshot) takeSnapshot();');
      assert(stopStart !== -1 && callAt !== -1, 'the per-card mark is applied inside onNodeDragStop');
      assert(rejectedAt !== -1 && rejectedAt < callAt, 'the per-card mark runs after the rejected-hub-drop early return');
      assert(callAt < snapshotAt, 'the per-card mark runs before the final undo snapshot');
      assert(hook.indexOf('markJobTreeLayoutUserArranged(nds, hubId)', stopStart) !== -1, 'the board-wide mark is still applied');
      assert(hook.indexOf('if (placedCardIds.length > 0) {', stopStart) !== -1, 'the per-card mark is only queued when a job card was dropped');
      const absorbAt = hook.indexOf('Absorbed ${movedIds.size} node(s)', stopStart);
      assert(absorbAt !== -1 && absorbAt < callAt, 'group absorption keeps its own early-return path');
    },
  },
];
