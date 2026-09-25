import { computeJobTreeView } from '../nodes/jobsearch/buildJobTree.js';
import { deriveBoardCardStats } from '../nodes/jobboard/mergeJobs.js';
import { hubCardFilter } from './jobCardFilters.js';

// Before this existed, only the card's own X button (JobCardNode's
// dismissCard) reflowed the job tree and recomputed the board's PERSISTED
// resultCount/finalSourceCounts/score-range fields on deletion. Keyboard
// Backspace/Delete and the right-click "Delete" context-menu item both let
// ReactFlow drop the node directly, so the board kept claiming a card count
// it no longer had — a value that is written to canvas.json and survives a
// restart. This is the one place all three deletion paths now converge
// (wired into ReactFlow's onNodesDelete in useCanvasOSDeletion.js, which
// fires for every node removal regardless of trigger).
//
/**
 * Pure per-hub cleanup plan for a batch of deleted nodes. Only entries of
 * type `jobcard` with a string `data.hubId` participate; everything else is
 * ignored so a delete that touches no job card costs nothing here.
 *
 * A selection can span several cards on more than one board, so cards are
 * grouped by hubId (first-seen order) and each board is processed once. The
 * reflowed node list is threaded from one board to the next so every
 * affected board's hidden/position updates land in one returned array —
 * `computeJobTreeView` only ever touches nodes whose own `data.hubId`
 * matches the hubId it was called with, so chaining calls for different
 * boards over the same array is safe.
 *
 * @param {object[]} deletedNodes       nodes removed in this transaction (any mix of types)
 * @param {object[]} nodesAfterRemoval  the caller's LEVEL-SCOPED live node list, with every
 *                                      node removed in this same transaction already excluded
 *                                      (mirrors dismissCard's original `getNodes().filter(node
 *                                      => node.id !== id)` idiom, generalized to a whole batch)
 * @param {(hubId: string) => (object|null|undefined)} getHubNode
 *   Resolves a board id to its live node. Callers decide what "live" means (see the
 *   cross-level-vs-level-scoped comments at each call site) — a nullish return is treated as
 *   "nothing to update" and never throws, which is also how a board deleted in the very same
 *   transaction (or otherwise unresolvable) is handled: its cards are skipped rather than
 *   restated for a board that's about to vanish.
 * @returns {{ treeNodes: object[], boardUpdates: { hubId: string, cardIds: string[], stats: object }[] }}
 *   `treeNodes` is the full post-reflow node list (pass to `setNodes`); `boardUpdates` is one
 *   `deriveBoardCardStats` result per affected board, plus the removed card ids that belonged
 *   to it, for the caller to write back and log.
 */
export function planJobCardDeletionCleanup(deletedNodes, nodesAfterRemoval, getHubNode) {
  const cardIdsByHub = new Map(); // hubId -> removed card ids, first-seen order
  for (const node of Array.isArray(deletedNodes) ? deletedNodes : []) {
    if (node?.type !== 'jobcard') continue;
    const hubId = node?.data?.hubId;
    if (typeof hubId !== 'string' || !hubId || !node.id) continue;
    if (!cardIdsByHub.has(hubId)) cardIdsByHub.set(hubId, []);
    cardIdsByHub.get(hubId).push(node.id);
  }

  let treeNodes = Array.isArray(nodesAfterRemoval) ? nodesAfterRemoval : [];
  const boardUpdates = [];
  for (const [hubId, cardIds] of cardIdsByHub) {
    const hubNode = getHubNode?.(hubId);
    if (!hubNode) continue;
    const hubData = hubNode.data || {};
    treeNodes = computeJobTreeView(treeNodes, hubId, hubCardFilter(hubData));
    boardUpdates.push({ hubId, cardIds, stats: deriveBoardCardStats(treeNodes, hubId, hubData) });
  }
  return { treeNodes, boardUpdates };
}
