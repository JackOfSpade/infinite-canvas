import React from 'react';
import { useReactFlow } from '@xyflow/react';
import { ChevronRight, ChevronDown, Plus } from 'lucide-react';
import { NodeHandles } from './_shared/NodeHandles';
import {
  computeLayoutPositions,
  COL_X,
} from './jobhub/buildJobTree';

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
 *                         are shown on expand; "Show more" reveals the next 10.
 *
 * Click toggles expand. Expanding flips `hidden: false` on each direct child up
 * to `visibleCount` (role leaves only — likelihood/salary show all direct
 * children at once). Collapsing recursively re-hides EVERYTHING under this node
 * so a closed parent never leaves stale visible descendants.
 *
 * data shape:
 *   {
 *     kind: 'likelihood' | 'salary' | 'role',
 *     label: string,
 *     count: number,
 *     hubId: string,
 *     childIds: string[],
 *     expanded?: boolean,
 *     visibleCount?: number,  // role only — how many cards are currently revealed
 *   }
 */
export function JobGroupNode({ id, data }) {
  const { setNodes, getNode, getNodes } = useReactFlow();

  const expanded = !!data.expanded;
  const kind = data.kind || 'role';
  const isLikelihood = kind === 'likelihood';
  const isSalary     = kind === 'salary';
  const isLeaf       = kind === 'role'; // leaf group: paginates its job cards
  // Hub-cascading lock: when the owning JobHub is locked, expand/collapse
  // becomes a no-op so the canvas state can't be mutated.
  const hubLocked = !!getNode(data.hubId)?.data?.locked;

  const accent = isLikelihood
    ? { border: '#a855f755', text: 'text-purple-100', count: 'bg-purple-500/25 text-purple-100' }
    : isSalary
      ? { border: '#3b82f655', text: 'text-blue-200',  count: 'bg-blue-500/25 text-blue-100' }
      : { border: '#14b8a655', text: 'text-teal-100',  count: 'bg-teal-500/25 text-teal-100' };

  const childIds = Array.isArray(data.childIds) ? data.childIds : [];
  const visibleCount = isLeaf
    ? Math.min(data.visibleCount ?? 10, childIds.length)
    : childIds.length;
  const hasMore = isLeaf && visibleCount < childIds.length;

  const toggle = (e) => {
    e.stopPropagation();
    if (hubLocked) return;
    if (childIds.length === 0) return;

    const hubPos = getNode(data.hubId)?.position || { x: 0, y: 0 };

    if (expanded) {
      // Collapsing: hide every descendant under this node, not just direct
      // children. A previously-expanded bucket under a category leaves its
      // jobs visible otherwise. Walk the tree by following childIds on any
      // visited JobGroupNode.
      const allNodes = getNodes();
      const byId = new Map(allNodes.map(n => [n.id, n]));
      const toHide = new Set();
      const queue = [...childIds];
      while (queue.length > 0) {
        const cid = queue.shift();
        if (toHide.has(cid)) continue;
        toHide.add(cid);
        const child = byId.get(cid);
        const grand = child?.data?.childIds;
        if (Array.isArray(grand)) queue.push(...grand);
      }
      setNodes(nodes => {
        const after = nodes.map(n => {
          if (n.id === id) {
            return {
              ...n,
              data: {
                ...n.data,
                expanded: false,
                ...(isLeaf ? { visibleCount: Math.min(10, childIds.length) } : {}),
              },
            };
          }
          if (toHide.has(n.id)) {
            const isGroup = n.type === 'jobgroup';
            if (isGroup) {
              return {
                ...n,
                hidden: true,
                data: {
                  ...n.data,
                  expanded: false,
                  ...(n.data?.kind === 'role'
                    ? { visibleCount: Math.min(10, (n.data?.childIds || []).length) }
                    : {}),
                },
              };
            }
            return { ...n, hidden: true };
          }
          return n;
        });
        const positions = computeLayoutPositions(after, data.hubId, COL_X, hubPos);
        return after.map(n => positions[n.id] ? { ...n, position: positions[n.id] } : n);
      });
    } else {
      // Expanding. Role leaves reveal up to `visibleCount` cards (paginated);
      // likelihood/salary groups reveal all direct children at once.
      const revealSet = isLeaf
        ? new Set(childIds.slice(0, visibleCount))
        : new Set(childIds);
      setNodes(nodes => {
        const after = nodes.map(n => {
          if (n.id === id) return { ...n, data: { ...n.data, expanded: true } };
          if (revealSet.has(n.id)) return { ...n, hidden: false };
          return n;
        });
        const positions = computeLayoutPositions(after, data.hubId, COL_X, hubPos);
        return after.map(n => positions[n.id] ? { ...n, position: positions[n.id] } : n);
      });
    }
  };

  const showMore = (e) => {
    e.stopPropagation();
    if (!isLeaf || !hasMore || hubLocked) return;
    const nextCount = Math.min(visibleCount + 10, childIds.length);
    const toReveal = new Set(childIds.slice(visibleCount, nextCount));
    const hubPos = getNode(data.hubId)?.position || { x: 0, y: 0 };
    setNodes(nodes => {
      const after = nodes.map(n => {
        if (n.id === id) return { ...n, data: { ...n.data, visibleCount: nextCount } };
        if (toReveal.has(n.id)) return { ...n, hidden: false };
        return n;
      });
      const positions = computeLayoutPositions(after, data.hubId, COL_X, hubPos);
      return after.map(n => positions[n.id] ? { ...n, position: positions[n.id] } : n);
    });
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
          {data.count ?? 0}
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
          title={`Show next ${Math.min(10, childIds.length - visibleCount)} of ${childIds.length - visibleCount} remaining`}
        >
          <Plus size={10} />
          Show {Math.min(10, childIds.length - visibleCount)} more · {childIds.length - visibleCount} left
        </button>
      )}
    </div>
  );
}
