import {
  ABSORB_EXCLUDED_TYPES,
  assert,
  buildGroupHoverState,
  collectAbsorptionClosure,
  findSeveredRelations,
  fs,
  getAbsorptionRejection,
  getNodeDims,
  hasActiveExternalRunState,
  isJobWorkflowDeletionPending,
  isJobWorkflowRelocationPending,
  markJobWorkflowDeletionPending,
  markJobWorkflowRelocationPending,
  MINIMAP_NODE_COLORS,
  partitionEdgesForMove,
  path,
  sanitizeNodesForSave,
  settleJobWorkflowDeletion,
  settleJobWorkflowRelocation,
} from '../test-dependencies.js';

export default [
{
    name: 'getAbsorptionRejection: a locked sub-canvas outranks every condition on the dragged nodes',
    run: () => {
      const targetGroupLocked = { id: 'g1', type: 'group', data: { locked: true } };
      const lockedNode = { id: 'n1', type: 'jobcard', data: { locked: true } };
      const groupInSet = { id: 'n2', type: 'group', data: {} };
      const activeHub = { id: 'hub1', type: 'jobhub', data: { hubState: 'searching' } };
      const rejection = getAbsorptionRejection([lockedNode, groupInSet, activeHub], targetGroupLocked);
      assert(rejection?.kind === 'reject' && rejection.label === 'Sub-canvas is locked',
        'getAbsorptionRejection: a locked target sub-canvas must be reported before any locked/excluded/running node in the drag set');
    },
  },
{
    name: 'getAbsorptionRejection: a locked dragged node outranks the excluded-type and active-run conditions',
    run: () => {
      const targetGroupOpen = { id: 'g2', type: 'group', data: {} };
      const lockedNode = { id: 'n1', type: 'jobcard', data: { locked: true } };
      const groupInSet = { id: 'n2', type: 'group', data: {} };
      const activeHub = { id: 'hub1', type: 'jobhub', data: { hubState: 'searching' } };
      const rejection = getAbsorptionRejection([lockedNode, groupInSet, activeHub], targetGroupOpen);
      assert(rejection?.kind === 'reject' && rejection.label === 'Unlock the node first',
        'getAbsorptionRejection: a locked dragged node must be reported before an excluded type or an active run elsewhere in the set');
    },
  },
{
    name: 'getAbsorptionRejection: an excluded type (a group) in the drag set outranks the active-run condition',
    run: () => {
      const targetGroupOpen = { id: 'g2', type: 'group', data: {} };
      const groupInSet = { id: 'n2', type: 'group', data: {} };
      const activeHub = { id: 'hub1', type: 'jobhub', data: { hubState: 'searching' } };
      assert(ABSORB_EXCLUDED_TYPES.has('group') && !ABSORB_EXCLUDED_TYPES.has('jobhub'),
        'getAbsorptionRejection: only a nested sub-canvas is excluded by type — module nodes are eligible by type');
      const rejection = getAbsorptionRejection([groupInSet, activeHub], targetGroupOpen);
      assert(rejection?.kind === 'reject' && rejection.label === 'Sub-canvases can’t nest',
        'getAbsorptionRejection: a nested sub-canvas in the drag set must be reported before an unrelated active run');
    },
  },
{
    name: 'getAbsorptionRejection: an active external run is the last-resort rejection when nothing else blocks the move',
    run: () => {
      const targetGroupOpen = { id: 'g2', type: 'group', data: {} };
      const activeHub = { id: 'hub1', type: 'jobhub', data: { hubState: 'searching' } };
      const rejection = getAbsorptionRejection([activeHub], targetGroupOpen);
      assert(rejection?.kind === 'reject' && rejection.label === 'Finish the run first',
        'getAbsorptionRejection: a running hub with no other blocker must fail on the run guard');
    },
  },
{
    name: 'getAbsorptionRejection: an eligible drag set is allowed, and no target group means nothing to reject against',
    run: () => {
      const targetGroupOpen = { id: 'g2', type: 'group', data: {} };
      const plainNode = { id: 'n3', type: 'jobcard', data: {} };
      assert(getAbsorptionRejection([plainNode], targetGroupOpen) === null,
        'getAbsorptionRejection: an unlocked, non-excluded, idle drag set must be allowed into an unlocked sub-canvas');
      const lockedNode = { id: 'n1', type: 'jobcard', data: { locked: true } };
      assert(getAbsorptionRejection([lockedNode], null) === null,
        'getAbsorptionRejection: with no target group there is nothing to reject against, regardless of the drag set');
    },
  },
{
    // The original bug: eligibility was decided from whichever node the user
    // happened to grab, not from the whole selection, so grabbing the jobhub
    // vs. grabbing a plain node it was selected alongside produced different
    // verdicts for the identical move. getAbsorptionRejection must evaluate
    // the whole set regardless of array order.
    name: 'getAbsorptionRejection regression: a jobhub + plain-node selection yields the same verdict regardless of which node was grabbed',
    run: () => {
      const targetGroupOpen = { id: 'g2', type: 'group', data: {} };
      const activeHub = { id: 'hub1', type: 'jobhub', data: { hubState: 'searching' } };
      const plainNode = { id: 'n3', type: 'jobcard', data: {} };
      const grabbedHub = getAbsorptionRejection([activeHub, plainNode], targetGroupOpen);
      const grabbedPlain = getAbsorptionRejection([plainNode, activeHub], targetGroupOpen);
      assert(grabbedHub?.label === 'Finish the run first' && grabbedPlain?.label === 'Finish the run first',
        'getAbsorptionRejection regression: grabbing the plain node in a selection that also contains a running jobhub must still surface the run guard, not silently allow the move');
      assert(JSON.stringify(grabbedHub) === JSON.stringify(grabbedPlain),
        'getAbsorptionRejection regression: the verdict for one drag set must be identical no matter which member was the grabbed node');

      const lockedNode = { id: 'n1', type: 'jobcard', data: { locked: true } };
      const idleHub = { id: 'hub2', type: 'jobhub', data: {} };
      const grabbedLocked = getAbsorptionRejection([lockedNode, idleHub], targetGroupOpen);
      const grabbedIdleHub = getAbsorptionRejection([idleHub, lockedNode], targetGroupOpen);
      assert(JSON.stringify(grabbedLocked) === JSON.stringify(grabbedIdleHub) && grabbedLocked?.label === 'Unlock the node first',
        'getAbsorptionRejection regression: grabbing the idle hub in a selection that also contains a locked node must still surface the lock guard');
    },
  },
{
    name: 'collectAbsorptionClosure: a jobhub pulls in its owned jobsourcecard children but not an unrelated card',
    run: () => {
      const hub = { id: 'hub', type: 'jobhub', data: {} };
      const src1 = { id: 'src1', type: 'jobsourcecard', data: { hubId: 'hub' } };
      const src2 = { id: 'src2', type: 'jobsourcecard', data: { hubId: 'hub' } };
      const other = { id: 'other', type: 'jobcard', data: {} };
      const allNodes = [hub, src1, src2, other];
      const closure = collectAbsorptionClosure([hub], allNodes);
      assert(closure.nodes.map(n => n.id).sort().join(',') === 'hub,src1,src2',
        'collectAbsorptionClosure: a jobhub must pull in every jobsourcecard it owns and nothing unrelated');
      assert(closure.addedIds.slice().sort().join(',') === 'src1,src2',
        'collectAbsorptionClosure: addedIds must list only the children pulled in beyond the seed');
      assert(closure.lockedBlockerId === null, 'collectAbsorptionClosure: an all-unlocked closure has no blocker');
    },
  },
{
    name: 'collectAbsorptionClosure: a jobboard pulls in its jobcard/jobgroup cascade, including childIds transitivity through a chain of jobgroups',
    run: () => {
      const board = { id: 'board', type: 'jobboard', data: {} };
      const card1 = { id: 'card1', type: 'jobcard', data: { hubId: 'board' } };
      const group1 = { id: 'group1', type: 'jobgroup', data: { hubId: 'board', childIds: ['card2', 'group2'] } };
      const card2 = { id: 'card2', type: 'jobcard', data: {} };
      // group2 has no hubId of its own — it is only reachable because group1
      // (already in the closure) lists it in childIds. Its own childIds must
      // then be walked too (transitivity), pulling in card3.
      const group2 = { id: 'group2', type: 'jobgroup', data: { childIds: ['card3'] } };
      const card3 = { id: 'card3', type: 'jobcard', data: {} };
      const unrelated = { id: 'unrelated', type: 'jobcard', data: {} };
      const allNodes = [board, card1, group1, card2, group2, card3, unrelated];
      const closure = collectAbsorptionClosure([board], allNodes);
      assert(closure.nodes.map(n => n.id).sort().join(',') === 'board,card1,card2,card3,group1,group2',
        'collectAbsorptionClosure: a jobboard cascade must include directly-owned cards/groups plus everything reachable through nested childIds, and nothing else');
      assert(closure.addedIds.slice().sort().join(',') === 'card1,card2,card3,group1,group2',
        'collectAbsorptionClosure: every non-seed member of the cascade must be reported in addedIds');
    },
  },
{
    name: 'collectAbsorptionClosure: a cyclic childIds reference (A owns B, B owns A) terminates instead of hanging',
    run: () => {
      const hub = { id: 'hub2', type: 'jobhub', data: {} };
      const groupA = { id: 'groupA', type: 'jobgroup', data: { hubId: 'hub2', childIds: ['groupB'] } };
      const groupB = { id: 'groupB', type: 'jobgroup', data: { childIds: ['groupA'] } };
      const closure = collectAbsorptionClosure([hub], [hub, groupA, groupB]);
      assert(closure.nodes.map(n => n.id).sort().join(',') === 'groupA,groupB,hub2',
        'collectAbsorptionClosure: a two-node childIds cycle must resolve to exactly the reachable set, not hang and not duplicate');
    },
  },
{
    name: 'collectAbsorptionClosure: a jobgroup that lists itself in its own childIds terminates instead of hanging',
    run: () => {
      // seedGroup is the seed; selfGroup is reachable only through childIds,
      // and its own childIds list points back at itself — this exercises the
      // self-reference through the childIds ownership path specifically
      // (not through a hubId shortcut), so it actually proves the fixpoint
      // loop's "already in the set" guard, not just that hubId ownership works.
      const seedGroup = { id: 'seedGroup', type: 'jobgroup', data: { childIds: ['selfGroup'] } };
      const selfGroup = { id: 'selfGroup', type: 'jobgroup', data: { childIds: ['selfGroup'] } };
      const closure = collectAbsorptionClosure([seedGroup], [seedGroup, selfGroup]);
      assert(closure.nodes.map(n => n.id).sort().join(',') === 'seedGroup,selfGroup',
        'collectAbsorptionClosure: a self-referential childIds entry must not hang or duplicate the node');
    },
  },
{
    name: 'collectAbsorptionClosure: a locked owned child sets lockedBlockerId and stops the closure from growing further',
    run: () => {
      const hub = { id: 'hub4', type: 'jobhub', data: {} };
      // lockedSrc precedes src2b in the scan order so the fixpoint loop hits
      // (and blocks on) it first, deterministically.
      const lockedSrc = { id: 'lockedSrc', type: 'jobsourcecard', data: { hubId: 'hub4', locked: true } };
      const src2b = { id: 'src2b', type: 'jobsourcecard', data: { hubId: 'hub4' } };
      const closure = collectAbsorptionClosure([hub], [hub, lockedSrc, src2b]);
      assert(closure.lockedBlockerId === 'lockedSrc',
        'collectAbsorptionClosure: a locked owned child must be reported as the blocker (caller turns this into "Unlock its cards first")');
      assert(!closure.nodes.some(n => n.id === 'src2b'),
        'collectAbsorptionClosure: growth must stop at the first locked blocker rather than continuing to pull in later children');
    },
  },
{
    name: 'collectAbsorptionClosure: a group (sub-canvas) node is never pulled in even if it carries a matching hubId',
    run: () => {
      const hub = { id: 'hub5', type: 'jobhub', data: {} };
      const weirdGroup = { id: 'weirdGroup', type: 'group', data: { hubId: 'hub5' } };
      const closure = collectAbsorptionClosure([hub], [hub, weirdGroup]);
      assert(closure.nodes.length === 1 && closure.nodes[0].id === 'hub5',
        'collectAbsorptionClosure: ownership can never pull a group/sub-canvas node into the closure, hubId lookalike or not');
    },
  },
{
    name: 'collectAbsorptionClosure: addedIds excludes members that were already present in the seed drag set',
    run: () => {
      const hub = { id: 'hub', type: 'jobhub', data: {} };
      const src1 = { id: 'src1', type: 'jobsourcecard', data: { hubId: 'hub' } };
      const src2 = { id: 'src2', type: 'jobsourcecard', data: { hubId: 'hub' } };
      // src1 is seeded directly in the drag set; only src2 should show up as newly added.
      const closure = collectAbsorptionClosure([hub, src1], [hub, src1, src2]);
      assert(closure.nodes.map(n => n.id).sort().join(',') === 'hub,src1,src2',
        'collectAbsorptionClosure: the final node set must still include every seeded and owned node');
      assert(closure.addedIds.join(',') === 'src2',
        'collectAbsorptionClosure: addedIds must report only nodes pulled in beyond the original seed, not the seed itself');
    },
  },
{
    name: 'partitionEdgesForMove: splits internal/external/crossing edges in one pass and tolerates a missing source or target',
    run: () => {
      const edges = [
        { id: 'e1', source: 'a', target: 'b' }, // both moving -> internal
        { id: 'e2', source: 'x', target: 'y' }, // neither moving -> external
        { id: 'e3', source: 'a', target: 'x' }, // only 'a' moving -> crossing
        { id: 'e4', target: 'b' }, // missing source, target moving -> crossing, must not throw
        { id: 'e5', source: 'a' }, // missing target, source moving -> crossing, must not throw
      ];
      const movedIds = new Set(['a', 'b']);
      const { internal, external, crossing } = partitionEdgesForMove(edges, movedIds);
      assert(internal.map(e => e.id).join(',') === 'e1', 'partitionEdgesForMove: an edge with both endpoints moving must be internal');
      assert(external.map(e => e.id).join(',') === 'e2', 'partitionEdgesForMove: an edge with neither endpoint moving must be external');
      assert(crossing.map(e => e.id).join(',') === 'e3,e4,e5',
        'partitionEdgesForMove: an edge with exactly one endpoint moving must be crossing, including when the other endpoint is entirely missing');
    },
  },
{
    name: 'partitionEdgesForMove: movedIds is accepted as either a Set or a plain array with identical results',
    run: () => {
      const edges = [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'a', target: 'z' },
      ];
      const fromSet = partitionEdgesForMove(edges, new Set(['a', 'b']));
      const fromArray = partitionEdgesForMove(edges, ['a', 'b']);
      assert(JSON.stringify(fromSet) === JSON.stringify(fromArray),
        'partitionEdgesForMove: passing movedIds as an array must partition identically to passing it as a Set');
    },
  },
{
    name: 'findSeveredRelations: owner-side reference fields are detected in both directions (moved-owner/stayed-target and stayed-owner/moved-target)',
    run: () => {
      const hubA = { id: 'hubA', type: 'jobhub', data: {} }; // stays
      const cardA = { id: 'cardA', type: 'jobcard', data: { originHubId: 'hubA' } }; // moves, references a stayed hub
      const hubB = { id: 'hubB', type: 'jobhub', data: {} }; // moves
      const cardB = { id: 'cardB', type: 'jobcard', data: { originHubId: 'hubB' } }; // stays, references a moved hub
      const boardA = { id: 'boardA', type: 'jobboard', data: {} }; // stays
      const srcC = { id: 'srcC', type: 'jobsourcecard', data: { hubId: 'hubA' } }; // moves, references a stayed hub
      const cardD = { id: 'cardD', type: 'jobcard', data: { hubId: 'boardA' } }; // moves, jobcard.hubId -> jobboard
      const boardB = { id: 'boardB', type: 'jobboard', data: {} }; // moves
      const groupE = { id: 'groupE', type: 'jobgroup', data: { hubId: 'boardB' } }; // stays, references a moved board

      const allNodes = [hubA, cardA, hubB, cardB, boardA, srcC, cardD, boardB, groupE];
      const movedIds = new Set(['cardA', 'hubB', 'srcC', 'cardD', 'boardB']);
      const { severedRefs } = findSeveredRelations(movedIds, allNodes, []);
      const keys = new Set(severedRefs.map(r => `${r.fromId}|${r.toId}|${r.field}`));
      assert(keys.has('cardA|hubA|originHubId'), 'findSeveredRelations: a moved jobcard referencing a stayed jobhub via originHubId must be severed');
      assert(keys.has('cardB|hubB|originHubId'), 'findSeveredRelations: a stayed jobcard referencing a moved jobhub via originHubId must be severed (the other direction)');
      assert(keys.has('srcC|hubA|hubId'), 'findSeveredRelations: a moved jobsourcecard referencing a stayed jobhub via hubId must be severed');
      assert(keys.has('cardD|boardA|hubId'), 'findSeveredRelations: a moved jobcard referencing a stayed jobboard via hubId must be severed');
      assert(keys.has('groupE|boardB|hubId'), 'findSeveredRelations: a stayed jobgroup referencing a moved jobboard via hubId must be severed (the other direction)');
      assert(severedRefs.length === 5, `findSeveredRelations: expected exactly the 5 severed owner-side references, got ${severedRefs.length}`);
    },
  },
{
    name: 'findSeveredRelations: jobboard array-reference fields are detected, duplicate ids de-duplicate, and same-side references are not reported',
    run: () => {
      const hubC = { id: 'hubC', type: 'jobhub', data: {} }; // stays
      const hubD = { id: 'hubD', type: 'jobhub', data: {} }; // moves, same side as boardB
      // hubC is listed twice in selectedSearchModuleIds; only one severed entry should result.
      const boardB = { id: 'boardB', type: 'jobboard', data: { selectedSearchModuleIds: ['hubC', 'hubC'], searchExecutionOrder: ['hubD'] } }; // moves
      const allNodes = [hubC, hubD, boardB];
      const movedIds = new Set(['boardB', 'hubD']);
      const { severedRefs } = findSeveredRelations(movedIds, allNodes, []);
      const keys = severedRefs.map(r => `${r.fromId}|${r.toId}|${r.field}`);
      assert(keys.filter(k => k === 'boardB|hubC|selectedSearchModuleIds').length === 1,
        'findSeveredRelations: a duplicate id in an array-reference field must produce exactly one severed entry, not one per repetition');
      assert(!keys.includes('boardB|hubD|searchExecutionOrder'),
        'findSeveredRelations: a reference field must not be reported when both the owner and the target move together');
      assert(severedRefs.length === 1, `findSeveredRelations: expected exactly 1 severed reference, got ${severedRefs.length}`);
    },
  },
{
    name: 'findSeveredRelations: jobhub entry-object reference fields (scoredJobs / preferenceCandidatePool) are detected',
    run: () => {
      const hubF = { id: 'hubF', type: 'jobhub', data: {} }; // stays
      const hubG = { id: 'hubG', type: 'jobhub', data: {} }; // stays
      const hubE = {
        id: 'hubE', type: 'jobhub', data: {
          scoredJobs: [{ originHubId: 'hubF' }, { title: 'no ref' }],
          preferenceCandidatePool: [{ originHubId: 'hubG' }],
        },
      }; // moves
      const allNodes = [hubF, hubG, hubE];
      const movedIds = new Set(['hubE']);
      const { severedRefs } = findSeveredRelations(movedIds, allNodes, []);
      const keys = new Set(severedRefs.map(r => `${r.fromId}|${r.toId}|${r.field}`));
      assert(keys.has('hubE|hubF|scoredJobs'), 'findSeveredRelations: a moved jobhub’s scoredJobs[].originHubId pointing at a stayed jobhub must be severed');
      assert(keys.has('hubE|hubG|preferenceCandidatePool'), 'findSeveredRelations: a moved jobhub’s preferenceCandidatePool[].originHubId pointing at a stayed jobhub must be severed');
      assert(severedRefs.length === 2, `findSeveredRelations: an entry with no originHubId must contribute nothing, got ${severedRefs.length} severed refs`);
    },
  },
{
    name: 'findSeveredRelations: a dangling id and an id resolving to the wrong node type are never counted',
    run: () => {
      const boardA = { id: 'boardA', type: 'jobboard', data: {} }; // stays; wrong type for jobcard.originHubId's jobhub target
      const danglingCard = { id: 'danglingCard', type: 'jobcard', data: { originHubId: 'ghost-id' } }; // moves
      const wrongTypeCard = { id: 'wrongTypeCard', type: 'jobcard', data: { originHubId: 'boardA' } }; // moves
      const allNodes = [boardA, danglingCard, wrongTypeCard];
      const movedIds = new Set(['danglingCard', 'wrongTypeCard']);
      const { severedRefs } = findSeveredRelations(movedIds, allNodes, []);
      assert(severedRefs.length === 0,
        'findSeveredRelations: an id that resolves to nothing, or to a node of the wrong type, must never be reported as severed');
    },
  },
{
    name: 'buildGroupHoverState: accepts with no label suffix when there are no cuts and no added children',
    run: () => {
      const hub = { id: 'hub', type: 'jobhub', data: {} };
      const targetGroup = { id: 'g', type: 'group', data: {} };
      const state = buildGroupHoverState([hub], targetGroup, [hub, targetGroup], []);
      assert(state.kind === 'accept' && state.label === 'Move into sub-canvas',
        'buildGroupHoverState: a clean single-node move with no severed references must accept with the plain label');
    },
  },
{
    name: 'buildGroupHoverState: reports a singular cut and a plural cut count with correct grammar',
    run: () => {
      const targetGroup = { id: 'g', type: 'group', data: {} };
      const hubX = { id: 'hubX', type: 'jobhub', data: {} }; // stays
      const hub = { id: 'hub', type: 'jobhub', data: { scoredJobs: [{ originHubId: 'hubX' }] } }; // moves, 1 severed ref
      const singular = buildGroupHoverState([hub], targetGroup, [hub, hubX, targetGroup], []);
      assert(singular.kind === 'accept' && singular.label === '1 connection will be cut',
        'buildGroupHoverState: exactly one cut must use the singular label');

      // Same severed reference, plus one crossing edge to a node outside the closure -> 2 cuts total.
      const outside = { id: 'outside', type: 'jobcard', data: {} };
      const edges = [{ id: 'e1', source: 'hub', target: 'outside' }];
      const plural = buildGroupHoverState([hub], targetGroup, [hub, hubX, outside, targetGroup], edges);
      assert(plural.kind === 'accept' && plural.label === '2 connections will be cut',
        'buildGroupHoverState: more than one cut must use the plural label with the exact count');
    },
  },
{
    name: 'buildGroupHoverState: every reject reason from getAbsorptionRejection and the closure’s own lockedBlockerId propagate through',
    run: () => {
      const openGroup = { id: 'g-open', type: 'group', data: {} };
      const lockedGroup = { id: 'g-locked', type: 'group', data: { locked: true } };
      const plainNode = { id: 'n', type: 'jobcard', data: {} };
      const lockedNode = { id: 'n-locked', type: 'jobcard', data: { locked: true } };
      const groupInSet = { id: 'n-group', type: 'group', data: {} };
      const activeHub = { id: 'hub-active', type: 'jobhub', data: { hubState: 'searching' } };

      assert(buildGroupHoverState([plainNode], lockedGroup, [plainNode, lockedGroup], [])?.label === 'Sub-canvas is locked',
        'buildGroupHoverState: a locked target sub-canvas must reject');
      assert(buildGroupHoverState([lockedNode], openGroup, [lockedNode, openGroup], [])?.label === 'Unlock the node first',
        'buildGroupHoverState: a locked dragged node must reject');
      assert(buildGroupHoverState([groupInSet], openGroup, [groupInSet, openGroup], [])?.label === 'Sub-canvases can’t nest',
        'buildGroupHoverState: a nested sub-canvas in the drag set must reject');
      assert(buildGroupHoverState([activeHub], openGroup, [activeHub, openGroup], [])?.label === 'Finish the run first',
        'buildGroupHoverState: an active external run must reject');

      const hub = { id: 'hub-locked-child', type: 'jobhub', data: {} };
      const lockedChild = { id: 'locked-child', type: 'jobsourcecard', data: { hubId: 'hub-locked-child', locked: true } };
      const blockerState = buildGroupHoverState([hub], openGroup, [hub, lockedChild, openGroup], []);
      assert(blockerState.kind === 'reject' && blockerState.label === 'Unlock its cards first',
        'buildGroupHoverState: a locked owned child discovered by the closure must reject with its own distinct label, ahead of getAbsorptionRejection');
    },
  },
{
    name: 'buildGroupHoverState: appends the total node count to the label when the closure pulled in extra children',
    run: () => {
      const targetGroup = { id: 'g', type: 'group', data: {} };
      const hub = { id: 'hub', type: 'jobhub', data: {} };
      const src1 = { id: 'src1', type: 'jobsourcecard', data: { hubId: 'hub' } };
      const src2 = { id: 'src2', type: 'jobsourcecard', data: { hubId: 'hub' } };
      const src3 = { id: 'src3', type: 'jobsourcecard', data: { hubId: 'hub' } };
      const allNodes = [hub, src1, src2, src3, targetGroup];
      const noCuts = buildGroupHoverState([hub], targetGroup, allNodes, []);
      assert(noCuts.kind === 'accept' && noCuts.label === 'Move 4 nodes into sub-canvas',
        'buildGroupHoverState: with no cuts, a closure larger than the raw selection must report the total node count');

      const hubX = { id: 'hubX', type: 'jobhub', data: {} };
      const hubWithRef = { id: 'hub2', type: 'jobhub', data: { scoredJobs: [{ originHubId: 'hubX' }] } };
      const src4 = { id: 'src4', type: 'jobsourcecard', data: { hubId: 'hub2' } };
      const withCuts = buildGroupHoverState([hubWithRef], targetGroup, [hubWithRef, src4, hubX, targetGroup], []);
      assert(withCuts.kind === 'accept' && withCuts.label === '1 connection will be cut · 2 nodes',
        'buildGroupHoverState: with both cuts and added children, the label must combine the cut count and the total node count');
    },
  },
{
    name: 'Relocation fence: refcounts balance — mark twice then settle once still pending, settle again clears it',
    run: () => {
      const nodes = [{ id: 'refcount-hub', type: 'jobhub', data: {} }];
      const idsA = markJobWorkflowRelocationPending(nodes);
      const idsB = markJobWorkflowRelocationPending(nodes);
      let settledOnce = false;
      try {
        assert(isJobWorkflowRelocationPending('refcount-hub'), 'Relocation fence: marking must set the node pending');
        settleJobWorkflowRelocation(idsA);
        settledOnce = true;
        assert(isJobWorkflowRelocationPending('refcount-hub'),
          'Relocation fence: settling one of two overlapping mark transactions must not clear the guard while the other still owns it');
        settleJobWorkflowRelocation(idsB);
        assert(!isJobWorkflowRelocationPending('refcount-hub'),
          'Relocation fence: settling the last outstanding mark transaction must clear the guard');
      } finally {
        if (!settledOnce) settleJobWorkflowRelocation(idsA);
        settleJobWorkflowRelocation(idsB);
      }
    },
  },
{
    name: 'Relocation fence: marks jobhub, jobboard, and sellhub, but not an unrelated node type',
    run: () => {
      const nodes = [
        { id: 'rh', type: 'jobhub', data: {} },
        { id: 'rb', type: 'jobboard', data: {} },
        { id: 'rs', type: 'sellhub', data: {} },
        { id: 'rc', type: 'jobcard', data: {} },
      ];
      const ids = markJobWorkflowRelocationPending(nodes);
      try {
        assert(ids.slice().sort().join(',') === 'rb,rh,rs',
          'Relocation fence: markJobWorkflowRelocationPending must mark jobhub, jobboard, and sellhub only');
        assert(isJobWorkflowRelocationPending('rh') && isJobWorkflowRelocationPending('rb') && isJobWorkflowRelocationPending('rs'),
          'Relocation fence: all three module types must read as pending after marking');
        assert(!isJobWorkflowRelocationPending('rc'), 'Relocation fence: a non-module node must never be marked pending');
      } finally {
        settleJobWorkflowRelocation(ids);
      }
    },
  },
{
    name: 'Relocation fence: recurses into nested canvasData to mark a hub inside a sub-canvas group',
    run: () => {
      const nodes = [{
        id: 'outer-group', type: 'group', data: {
          canvasData: { nodes: [{ id: 'nested-hub', type: 'jobhub', data: {} }] },
        },
      }];
      const ids = markJobWorkflowRelocationPending(nodes);
      try {
        assert(ids.includes('nested-hub'), 'Relocation fence: marking must recurse into canvasData.nodes to find nested module nodes');
        assert(isJobWorkflowRelocationPending('nested-hub'), 'Relocation fence: a nested hub must read as pending after marking its containing tree');
      } finally {
        settleJobWorkflowRelocation(ids);
      }
    },
  },
{
    name: 'Relocation fence is independent of the deletion fence: settling one must never clear the other for the same node id',
    run: () => {
      const nodeA = [{ id: 'shared-id-a', type: 'jobhub', data: {} }];
      const relocIdsA = markJobWorkflowRelocationPending(nodeA);
      const delIdsA = markJobWorkflowDeletionPending(nodeA);
      let relocSettledA = false;
      let delSettledA = false;
      try {
        assert(isJobWorkflowRelocationPending('shared-id-a') && isJobWorkflowDeletionPending('shared-id-a'),
          'Relocation/deletion independence: a node can legitimately be pending in both fences at once');
        settleJobWorkflowRelocation(relocIdsA);
        relocSettledA = true;
        assert(!isJobWorkflowRelocationPending('shared-id-a') && isJobWorkflowDeletionPending('shared-id-a'),
          'Relocation/deletion independence: settling the relocation fence must not clear a pending deletion for the same id');
        settleJobWorkflowDeletion(delIdsA);
        delSettledA = true;
        assert(!isJobWorkflowDeletionPending('shared-id-a'), 'Relocation/deletion independence: the deletion fence still settles on its own settle call');
      } finally {
        if (!relocSettledA) settleJobWorkflowRelocation(relocIdsA);
        if (!delSettledA) settleJobWorkflowDeletion(delIdsA);
      }

      // And the reverse order: settling the deletion fence must not clear a pending relocation.
      const nodeB = [{ id: 'shared-id-b', type: 'jobboard', data: {} }];
      const delIdsB = markJobWorkflowDeletionPending(nodeB);
      const relocIdsB = markJobWorkflowRelocationPending(nodeB);
      let delSettledB = false;
      let relocSettledB = false;
      try {
        settleJobWorkflowDeletion(delIdsB);
        delSettledB = true;
        assert(!isJobWorkflowDeletionPending('shared-id-b') && isJobWorkflowRelocationPending('shared-id-b'),
          'Relocation/deletion independence: settling the deletion fence must not clear a pending relocation for the same id (the reverse direction)');
        settleJobWorkflowRelocation(relocIdsB);
        relocSettledB = true;
        assert(!isJobWorkflowRelocationPending('shared-id-b'), 'Relocation/deletion independence: the relocation fence still settles on its own settle call');
      } finally {
        if (!delSettledB) settleJobWorkflowDeletion(delIdsB);
        if (!relocSettledB) settleJobWorkflowRelocation(relocIdsB);
      }
    },
  },
{
    name: 'hasActiveExternalRunState: a SellHub mid photo-analysis or comp-research reads as an active external run',
    run: () => {
      assert(hasActiveExternalRunState([{ id: 's1', type: 'sellhub', data: { hubState: 'analyzing' } }]) === true,
        'hasActiveExternalRunState: SellHub hubState "analyzing" must count as an active run');
      assert(hasActiveExternalRunState([{ id: 's2', type: 'sellhub', data: { hubState: 'researching' } }]) === true,
        'hasActiveExternalRunState: SellHub hubState "researching" must count as an active run');
      assert(hasActiveExternalRunState([{ id: 's3', type: 'sellhub', data: { hubState: 'draft', queuedModuleRun: { label: 'x' } } }]) === true,
        'hasActiveExternalRunState: a SellHub with a queuedModuleRun marker must count as active even in a terminal hubState');
      assert(hasActiveExternalRunState([{ id: 's4', type: 'sellhub', data: { hubState: 'priced', platformFitPending: true } }]) === true,
        'hasActiveExternalRunState: a SellHub mid post-pricing fit assessment (platformFitPending) must count as active even though hubState is already terminal');
    },
  },
{
    name: 'hasActiveExternalRunState: a SellHub in a terminal state with no pending markers is not active, and marketplacestatus is deliberately never guarded',
    run: () => {
      for (const hubState of ['empty', 'draft', 'priced', 'comps-ready']) {
        assert(hasActiveExternalRunState([{ id: `sh-${hubState}`, type: 'sellhub', data: { hubState } }]) === false,
          `hasActiveExternalRunState: SellHub terminal state "${hubState}" with no pending markers must not count as active`);
      }
      // marketplacestatus keeps its scan in a module-level store, not node data,
      // so it must never be treated as an active run guard even if it happened
      // to carry SellHub-shaped fields.
      const lookalike = { id: 'ms1', type: 'marketplacestatus', data: { hubState: 'analyzing', queuedModuleRun: { x: 1 }, platformFitPending: true } };
      assert(hasActiveExternalRunState([lookalike]) === false,
        'hasActiveExternalRunState: marketplacestatus must never be treated as an active external run, by design');
    },
  },
{
    name: 'sanitizeNodesForSave strips dragHover from a top-level node, a group node, and a node nested inside a group’s canvasData',
    run: () => {
      const nodes = [
        { id: 'top', type: 'jobcard', position: { x: 0, y: 0 }, data: { title: 'A', dragHover: { kind: 'accept', label: 'Move into sub-canvas' } } },
        {
          id: 'grp', type: 'group', position: { x: 1, y: 1 }, data: {
            dragHover: { kind: 'reject', label: 'Finish the run first' },
            canvasData: {
              nodes: [
                { id: 'inner', type: 'jobcard', position: { x: 0, y: 0 }, data: { title: 'B', dragHover: { kind: 'accept', label: 'x' } } },
              ],
              edges: [],
              drawings: [],
            },
          },
        },
      ];
      const sanitized = sanitizeNodesForSave(nodes);
      const top = sanitized.find(n => n.id === 'top');
      const grp = sanitized.find(n => n.id === 'grp');
      const inner = grp?.data?.canvasData?.nodes?.find(n => n.id === 'inner');
      assert(top && !('dragHover' in top.data), 'sanitizeNodesForSave: dragHover must be stripped from a top-level node');
      assert(grp && !('dragHover' in grp.data), 'sanitizeNodesForSave: dragHover must be stripped from a group node itself');
      assert(inner && !('dragHover' in inner.data), 'sanitizeNodesForSave: dragHover must be stripped from a node nested inside a group’s canvasData');
    },
  },
{
    name: 'getNodeDims returns jobboard/marketplacestatus’s real fallback dimensions, not the generic 120x40 placeholder, when unmeasured',
    run: () => {
      const jobboardDims = getNodeDims({ type: 'jobboard' });
      const marketplaceStatusDims = getNodeDims({ type: 'marketplacestatus' });
      assert(jobboardDims.w === 260 && jobboardDims.h === 320,
        `getNodeDims: an unmeasured jobboard node must use its real NODE_DIMS fallback (260x320), got ${jobboardDims.w}x${jobboardDims.h}`);
      assert(marketplaceStatusDims.w === 296 && marketplaceStatusDims.h === 214,
        `getNodeDims: an unmeasured marketplacestatus node must use its real NODE_DIMS fallback (296x214), got ${marketplaceStatusDims.w}x${marketplaceStatusDims.h}`);
      assert(jobboardDims.w !== 120 && jobboardDims.h !== 40 && marketplaceStatusDims.w !== 120 && marketplaceStatusDims.h !== 40,
        'getNodeDims: neither node type may fall through to the generic 120x40 placeholder, or a reloaded nested Job Board/Marketplace Status draws as a grey box in the thumbnail/minimap');
    },
  },
{
    name: 'MINIMAP_NODE_COLORS has a distinct color entry for every node type introduced by absorption (jobboard, jobgroup, jobsourcecard, marketplacestatus, compsourcecard)',
    run: () => {
      const requiredTypes = ['jobboard', 'jobgroup', 'jobsourcecard', 'marketplacestatus', 'compsourcecard'];
      const hexColor = /^#[0-9a-f]{6}$/i;
      for (const type of requiredTypes) {
        assert(typeof MINIMAP_NODE_COLORS[type] === 'string' && hexColor.test(MINIMAP_NODE_COLORS[type]),
          `MINIMAP_NODE_COLORS: missing or malformed color entry for "${type}" — a reloaded nested canvas would draw it as an unstyled minimap dot`);
      }
      const distinct = new Set(requiredTypes.map(type => MINIMAP_NODE_COLORS[type]));
      assert(distinct.size === requiredTypes.length,
        'MINIMAP_NODE_COLORS: each of these node types must be visually distinguishable on the minimap, not sharing a color');
    },
  },
{
    name: 'buildGroupHoverState: a locked target sub-canvas outranks a locked owned child in the drag set’s own closure',
    run: () => {
      // Same closure (hub + a locked owned child) evaluated against a locked
      // vs. an unlocked target group. Unlocking the child would not make this
      // drop succeed while the target group itself stays locked, so a locked
      // target must report 'Sub-canvas is locked' rather than sending the
      // user to fix the wrong thing.
      const hub = { id: 'hub-lockprec', type: 'jobhub', data: {} };
      const lockedChild = { id: 'child-lockprec', type: 'jobsourcecard', data: { hubId: 'hub-lockprec', locked: true } };

      const lockedTarget = { id: 'g-locked-lockprec', type: 'group', data: { locked: true } };
      const rejectedOnTarget = buildGroupHoverState([hub], lockedTarget, [hub, lockedChild, lockedTarget], []);
      assert(rejectedOnTarget.kind === 'reject' && rejectedOnTarget.label === 'Sub-canvas is locked',
        'buildGroupHoverState: when the target sub-canvas is locked AND the closure also has a locked owned child, the label must be "Sub-canvas is locked" — unlocking the child would still not let the drop succeed while the target stays locked, so reporting the child would send the user to fix the wrong thing');

      const openTarget = { id: 'g-open-lockprec', type: 'group', data: {} };
      const rejectedOnChild = buildGroupHoverState([hub], openTarget, [hub, lockedChild, openTarget], []);
      assert(rejectedOnChild.kind === 'reject' && rejectedOnChild.label === 'Unlock its cards first',
        'buildGroupHoverState: with the identical locked child but an unlocked target, the closure’s own blocker must still be reported — the target-lock precedence above must not swallow this case too');
    },
  },
{
    name: 'findSeveredRelations: a hubId backlink that merely restates an already-counted edge is not double-counted, regardless of which side the edge stores as source, but an edge-less reference is still reported',
    run: () => {
      // Part 1 — the exact double-count scenario: a jobhub + one
      // jobsourcecard linked by BOTH a real React Flow edge AND a parallel
      // data.hubId backlink (every job-tree link is stored both ways — see
      // this function's own comment). Moving only the card must report the
      // cut once total, not once per storage mechanism.
      const hubP1 = { id: 'hubP1', type: 'jobhub', data: {} }; // stays
      const cardP1 = { id: 'cardP1', type: 'jobsourcecard', data: { hubId: 'hubP1' } }; // moves
      const edgeP1 = [{ id: 'eP1', source: 'hubP1', target: 'cardP1' }];
      const resultP1 = findSeveredRelations(new Set(['cardP1']), [hubP1, cardP1], edgeP1);
      const totalP1 = resultP1.crossingEdges.length + resultP1.severedRefs.length;
      assert(totalP1 === 1,
        `findSeveredRelations: a job-tree link stored as both a React Flow edge and a data.hubId backlink must be reported once total, got ${totalP1} (crossingEdges=${resultP1.crossingEdges.length}, severedRefs=${resultP1.severedRefs.length})`);

      // Part 2 — dedup must not over-suppress: a hubId backlink with no
      // corresponding edge at all is a real cut and must still surface.
      const hubP2 = { id: 'hubP2', type: 'jobhub', data: {} }; // stays
      const cardP2 = { id: 'cardP2', type: 'jobsourcecard', data: { hubId: 'hubP2' } }; // moves, no edge to hubP2
      const resultP2 = findSeveredRelations(new Set(['cardP2']), [hubP2, cardP2], []);
      assert(resultP2.severedRefs.length === 1 && resultP2.severedRefs[0].fromId === 'cardP2' && resultP2.severedRefs[0].toId === 'hubP2',
        'findSeveredRelations: a hubId backlink with no matching edge must still be reported as severed — the dedup must not over-suppress references that have no edge duplicate at all');

      // Part 3 — direction insensitivity: the backlink field always points
      // card->hub (fromId=card, toId=hub), but the edge itself can be stored
      // with either endpoint as `source`. Both orderings must suppress the
      // duplicate identically.
      const hubP3 = { id: 'hubP3', type: 'jobhub', data: {} };
      const cardP3 = { id: 'cardP3', type: 'jobsourcecard', data: { hubId: 'hubP3' } };
      const edgeHubToCard = [{ id: 'eP3a', source: 'hubP3', target: 'cardP3' }];
      const resultHubToCard = findSeveredRelations(new Set(['cardP3']), [hubP3, cardP3], edgeHubToCard);
      assert(resultHubToCard.crossingEdges.length + resultHubToCard.severedRefs.length === 1,
        'findSeveredRelations: an edge stored source(hub)->target(card) must suppress the card->hub backlink duplicate');
      const edgeCardToHub = [{ id: 'eP3b', source: 'cardP3', target: 'hubP3' }];
      const resultCardToHub = findSeveredRelations(new Set(['cardP3']), [hubP3, cardP3], edgeCardToHub);
      assert(resultCardToHub.crossingEdges.length + resultCardToHub.severedRefs.length === 1,
        'findSeveredRelations: an edge stored source(card)->target(hub) must also suppress the card->hub backlink duplicate — the pair match must be direction-insensitive, not tied to which endpoint is `source`');
    },
  },
{
    // No renderer harness exists for these two hooks, so the invariants are
    // locked down as source-text assertions — the technique fixtures-canvas.js
    // already uses heavily (see its `generationScope` slices). Kept as one
    // test covering all three related fixes since they were found together.
    name: 'source-invariant: hub-vs-group drop precedence, the hub-hover type gate, and honest extraction-id logging survive in useDragCorrections/useCanvasNavigation',
    run: () => {
      const dragSource = fs.readFileSync(path.resolve('src/hooks/useDragCorrections.js'), 'utf8');
      const navSource = fs.readFileSync(path.resolve('src/hooks/useCanvasNavigation.js'), 'utf8');

      // Once a sub-canvas drop target has been found, the group-absorption
      // branch alone decides the outcome — including its deliberate
      // "refused, left as an ordinary move" case. The hub snap-back branch
      // must stay guarded by `!targetGroup`, or a drop overlapping both a
      // group and a hub gets snapped back and the log blames the hub for a
      // rejection the group actually made.
      assert(dragSource.includes('if (!targetGroup && targetHub) {'),
        'onNodeDragStop: the hub snap-back branch must be guarded by `!targetGroup` so a found sub-canvas target always owns the outcome of the drop, never the hub branch underneath it');

      // onNodeDrag's hover cue and onNodeDragStop's actual drop resolution
      // must gate their targetHub lookup on the identical node-type test. A
      // hover cue must never be shown for an interaction the drop path will
      // not act on — dragging a Job Search over another Job Search previously
      // lit the target up with "Unsupported component" for nothing. A
      // dragged Job Board is deliberately NOT excluded from either gate.
      const onNodeDragStart = dragSource.indexOf('const onNodeDrag = useCallback');
      const onNodeDragStopStart = dragSource.indexOf('const onNodeDragStop = useCallback');
      assert(onNodeDragStart >= 0 && onNodeDragStopStart > onNodeDragStart,
        'source-invariant: both onNodeDrag and onNodeDragStop markers must be present and ordered as expected for the slices below to actually isolate each function');
      const onNodeDragScope = dragSource.slice(onNodeDragStart, onNodeDragStopStart);
      const onNodeDragStopScope = dragSource.slice(onNodeDragStopStart);
      const hubTypeGate = 'HUB_DROP_TARGET_TYPES.has(node.type)';
      assert(onNodeDragScope.includes(hubTypeGate) && onNodeDragStopScope.includes(hubTypeGate),
        'onNodeDrag and onNodeDragStop must gate their targetHub resolution on the identical HUB_DROP_TARGET_TYPES.has(node.type) test, or the hover cue can promise a drop outcome the drop path will not actually deliver');

      // extractToLevel must report what it actually extracted, not what was
      // requested — the closure can pull a hub's owned children along, so the
      // caller cannot derive the true moved set from the ids it passed in.
      assert(navSource.includes('return finalIds;'),
        'extractToLevel: must return the ids it actually extracted (the resolved closure, finalIds), not the originally requested ids');
      assert(dragSource.includes('const extractedIds = extractToLevel('),
        'onNodeDragStop breadcrumb handler: must capture and log extractToLevel’s return value (what actually moved) rather than the ids it requested — the closure can silently pull in more');
    },
  },
];
