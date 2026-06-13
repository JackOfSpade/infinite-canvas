import React, { useCallback } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import { ChevronRight, ChevronDown, Plus } from 'lucide-react';
import { NodeHandles } from './_shared/NodeHandles';
import { EventLogger } from '../utils/EventLogger';
import { computeJobTreeView, countMatchingDescendantCards } from './jobsearch/buildJobTree';

/**
 * JobGroupNode — collapsible header that owns a slice of the job-tree.
 *
 * Three kinds share this component (different accent; one layout, deepest last):
 *   - kind='likelihood' — interview-likelihood band (top level). Children are
 *                         salary-range groups. Reveals all on expand.
 *   - kind='salary'     — salary range inside a band. Children are role groups.
 *                         Reveals all on expand.
 *   - kind='role'       — job-role grouping (the LEAF). Children are JobCardNode.
 *                         Paginated: only the first `visibleCount` (default 10)
 *                         MATCHING cards are shown on expand; "Show more"
 *                         reveals the next 10.
 *
 * Click toggles expand. Collapsing recursively re-hides EVERYTHING under this
 * node so a closed parent never leaves stale visible descendants.
 *
 * The count badge and the pagination math are LIVE: they count the matching,
 * still-on-canvas descendant cards via a store selector — cards are disposable
 * (dismissal is the primary interaction) and the spawned `data.count`/raw
 * childIds would otherwise drift stale, showing ghost counts and pagination
 * windows full of deleted ids. The owning hub's lock flag is read through the
 * same reactive store so locking the board freezes already-mounted groups too.
 *
 * data shape:
 *   {
 *     kind: 'likelihood' | 'salary' | 'role',
 *     label: string,
 *     count: number,         // spawn-time total (display fallback only)
 *     hubId: string,
 *     childIds: string[],
 *     expanded?: boolean,
 *     visibleCount?: number, // role only — how many matching cards are revealed
 *   }
 */
export function JobGroupNode({ id, data }) {
  const { setNodes, getNode } = useReactFlow();

  const expanded = !!data.expanded;
  const kind = data.kind || 'role';
  const isLikelihood = kind === 'likelihood';
  const isSalary     = kind === 'salary';
  const isLeaf       = kind === 'role'; // leaf group: paginates its job cards
  const childIds = Array.isArray(data.childIds) ? data.childIds : [];

  // Hub-cascading lock + live matching-card count, both reactive: a plain
  // getNode() read goes stale on already-mounted groups (locking the hub or
  // dismissing a card doesn't re-render THIS node), so badge, "Show more"
  // math, and the lock guard all derive from a store selector instead.
  const hubLocked = useStore(
    useCallback((s) => !!s.nodeLookup.get(data.hubId)?.data?.locked, [data.hubId])
  );
  const liveCount = useStore(
    useCallback((s) => {
      const hubData = s.nodeLookup.get(data.hubId)?.data || {};
      return countMatchingDescendantCards(
        data.childIds || [],
        (nid) => s.nodeLookup.get(nid),
        { scoreThreshold: hubData.scoreThreshold ?? 0, sourceFilter: hubData.sourceFilter ?? null },
      );
    }, [data.hubId, data.childIds])
  );

  const visibleCount = isLeaf
    ? Math.min(data.visibleCount ?? 10, liveCount)
    : liveCount;
  const hasMore = isLeaf && visibleCount < liveCount;
  const remaining = liveCount - visibleCount;

  const accent = isLikelihood
    ? { border: '#a855f755', text: 'text-purple-100', count: 'bg-purple-500/25 text-purple-100' }
    : isSalary
      ? { border: '#3b82f655', text: 'text-blue-200',  count: 'bg-blue-500/25 text-blue-100' }
      : { border: '#14b8a655', text: 'text-teal-100',  count: 'bg-teal-500/25 text-teal-100' };

  // The owning hub/board's active card filter — reveal must respect it, so an
  // expand under a filter only shows matching cards / non-empty branches.
  const hubFilter = () => {
    const d = getNode(data.hubId)?.data || {};
    return { scoreThreshold: d.scoreThreshold ?? 0, sourceFilter: d.sourceFilter ?? null };
  };

  const toggle = (e) => {
    e.stopPropagation();
    if (hubLocked) return;
    if (childIds.length === 0) return;

    const willExpand = !expanded;
    const filter = hubFilter();

    setNodes(nodes => {
      const byId = new Map(nodes.map(n => [n.id, n]));
      // On collapse, reset the whole subtree's expanded/visibleCount so a later
      // re-expand starts fresh (computeJobTreeView then derives `hidden`).
      const resetIds = new Set();
      if (!willExpand) {
        const queue = [...childIds];
        while (queue.length > 0) {
          const cid = queue.shift();
          if (resetIds.has(cid)) continue;
          resetIds.add(cid);
          const grand = byId.get(cid)?.data?.childIds;
          if (Array.isArray(grand)) queue.push(...grand);
        }
      }
      const updated = nodes.map(n => {
        if (n.id === id) {
          return {
            ...n,
            data: {
              ...n.data,
              expanded: willExpand,
              ...(isLeaf && !willExpand ? { visibleCount: Math.min(10, childIds.length) } : {}),
            },
          };
        }
        if (resetIds.has(n.id) && n.type === 'jobgroup' && (n.data?.expanded || n.data?.visibleCount)) {
          return {
            ...n,
            data: {
              ...n.data,
              expanded: false,
              ...(n.data?.kind === 'role' ? { visibleCount: Math.min(10, (n.data?.childIds || []).length) } : {}),
            },
          };
        }
        return n;
      });
      return computeJobTreeView(updated, data.hubId, filter);
    });
    EventLogger.log(`[JobTree] ${willExpand ? 'expanded' : 'collapsed'} ${kind} "${data.label}" id=${id}`);
  };

  const showMore = (e) => {
    e.stopPropagation();
    if (!isLeaf || !hasMore || hubLocked) return;
    const nextCount = Math.min(visibleCount + 10, liveCount);
    const filter = hubFilter();
    setNodes(nodes =>
      computeJobTreeView(
        nodes.map(n => (n.id === id ? { ...n, data: { ...n.data, visibleCount: nextCount } } : n)),
        data.hubId,
        filter,
      ),
    );
    EventLogger.log(`[JobTree] show more in role "${data.label}" id=${id} (now ${nextCount}/${liveCount})`);
  };

  return (
    <div
      onClick={toggle}
      className={`w-[240px] rounded-2xl bg-neutral-900/95 border-2 shadow-lg overflow-hidden transition-all ${
        hubLocked ? 'cursor-default' : 'cursor-pointer hover:brightness-110'
      }`}
      style={{ borderColor: accent.border }}
      title={hubLocked
        ? 'Hub is locked'
        : (expanded ? `Click to collapse ${data.label}` : `Click to expand ${data.label}`)}
    >
      <NodeHandles className="!w-2 !h-2 !bg-white/30 !border-white/10" />
      <div className="flex items-center gap-2 px-3 py-2">
        {expanded
          ? <ChevronDown size={14} className="text-white/60 shrink-0" />
          : <ChevronRight size={14} className="text-white/60 shrink-0" />}
        <span className={`flex-1 min-w-0 text-[12px] font-semibold truncate ${accent.text}`}>{data.label}</span>
        <span className={`text-[10px] font-bold leading-none px-2 py-1 rounded-full ${accent.count}`}>
          {liveCount}
        </span>
      </div>
      {/* Pagination control: only on expanded buckets that have more hidden
          jobs. Sits inside the same card so it scrolls with the bucket
          rather than as a floating button on the canvas. */}
      {expanded && hasMore && (
        <button
          onClick={showMore}
          onPointerDown={(e) => e.stopPropagation()}
          className="nodrag w-full flex items-center justify-center gap-1 px-2 py-1.5 bg-white/[0.03] hover:bg-white/10 text-white/50 hover:text-white/80 text-[10px] border-t border-white/5 transition-colors"
          title={`Show next ${Math.min(10, remaining)} of ${remaining} remaining`}
        >
          <Plus size={10} />
          Show {Math.min(10, remaining)} more · {remaining} left
        </button>
      )}
    </div>
  );
}
