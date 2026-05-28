import { getNodeDims } from './constants.js';
import {
  getJobHubTransientKeysForSave,
  SELLHUB_TRANSIENT_KEYS,
  TRANSIENT_PROCESSING_HUB_STATES,
} from './persistenceTransientState.js';

/** Stable, pure snapshot fingerprint — no hook needed. */
export function fingerprint(snap) {
  if (!snap || !snap.nodes) return '';
  const n = snap.nodes;
  const e = snap.edges || [];
  const d = snap.drawings || [];
  return JSON.stringify({
    n: n.map(x => {
      // Optimization: avoid heavy recursive serialization for the fingerprint.
      // Instead, include a "deep summary" of nested canvas data (counts/lengths)
      // so changes inside groups trigger a state change detection, enabling undo/redo.
      let data = x.data;
      let summary = null;
      if (x.type === 'group' && data?.canvasData) {
        const { canvasData, ...rest } = data;
        data = rest;
        summary = {
          nc: canvasData.nodes?.length || 0,
          ec: canvasData.edges?.length || 0,
          dc: canvasData.drawings?.length || 0
        };
      }
      return { id: x.id, x: x.position?.x, y: x.position?.y, t: x.type, d: data, s: x.style, sm: summary };
    }),
    e: e.map(x => ({ id: x.id, s: x.source, t: x.target })),
    dl: d.map(x => {
      if (!x) return null;
      const pts   = Array.isArray(x) ? x : (x.points || []);
      const first = pts[0];
      const last  = pts[pts.length - 1];
      // Defensive: only record coords if they exist
      const fCoord = first ? [first.x, first.y] : null;
      const lCoord = last ? [last.x, last.y] : null;
      // Also sample the middle point to detect shape changes that preserve first/last/length
      const mid = pts.length > 2 ? pts[Math.floor(pts.length / 2)] : null;
      const mCoord = mid ? [mid.x, mid.y] : null;

      return { c: x.color, pl: pts.length, f: fCoord, l: lCoord, m: mCoord };
    }),
  });
}

/**
 * Recursively migrate old group nodes from separate data.nodes/edges/drawings
 * to the unified data.canvasData structure.
 */
export function migrateGroupNodes(nodes) {
  if (!Array.isArray(nodes)) return [];
  return nodes.map(node => {
    if (node.type === 'group' && !node.data?.canvasData && (node.data?.nodes || node.data?.edges || node.data?.drawings)) {
      const { nodes: innerNodes, edges: innerEdges, drawings: innerDrawings,
              collapsed: _collapsed, pushedNodes: _pushedNodes, items: _items, ...restData } = node.data;
      const { dragHandle: _dragHandle, ...restNode } = node;
      return {
        ...restNode,
        style: { width: getNodeDims(node).w || 180, height: getNodeDims(node).h || 130 },
        data: {
          ...restData,
          canvasData: {
            nodes: migrateGroupNodes(innerNodes || []),
            edges: innerEdges || [],
            drawings: innerDrawings || [],
          },
        },
      };
    }
    // Ensure locked nodes have deletable: false (added retroactively).
    // Use a separate variable — arrow-function parameters are const and cannot be reassigned.
    let current = node;
    if (current.data?.locked && current.deletable !== false) {
      current = { ...current, deletable: false };
    }
    // Recurse into existing canvasData for new-format group nodes
    if (current.type === 'group' && current.data?.canvasData?.nodes?.length > 0) {
      const migratedInner = migrateGroupNodes(current.data.canvasData.nodes);
      if (migratedInner !== current.data.canvasData.nodes) {
        return {
          ...current,
          data: {
            ...current.data,
            canvasData: { ...current.data.canvasData, nodes: migratedInner },
          },
        };
      }
    }
    return current;
  });
}

/**
 * Strip transient visual properties from nodes before saving.
 * Prevents runtime-only state (e.g. source-filter dim opacity) from
 * being persisted to disk and corrupting the loaded workspace.
 *
 * This is recursive: group (CanvasNode) nodes can contain arbitrary
 * nested canvases, so we must sanitize down every level.
 */
/**
 * Drop edges whose source or target node no longer exists in the live set.
 * Orphan edges accumulate when a node is force-deleted from outside the
 * regular delete path (or before the cascade-cleanup utility existed), then
 * persist forever in the saved JSON — bloating the file and rendering as
 * dashed lines to phantom positions on the minimap.
 *
 * Call this AFTER sanitizeNodesForSave (which may have dropped ephemerals),
 * passing the SANITIZED node list so edges to dropped nodes are also pruned.
 */
export function sanitizeEdgesForSave(edges, sanitizedNodes) {
  if (!Array.isArray(edges)) return edges;
  // Build the live node-id set, recursing into group-node canvasData so
  // edges that target nodes inside a sub-canvas aren't mistakenly orphaned.
  // (Edges at one level can only reference nodes at the same level in
  // ReactFlow's data model, but recursing is cheap insurance against any
  // future shape change.)
  const liveIds = new Set();
  const collect = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const n of arr) {
      if (!n?.id) continue;
      liveIds.add(n.id);
      if (n.type === 'group' && n.data?.canvasData?.nodes) collect(n.data.canvasData.nodes);
    }
  };
  collect(sanitizedNodes);
  return edges.filter(e => liveIds.has(e?.source) && liveIds.has(e?.target));
}

export function sanitizeNodesForSave(nodes) {
  if (!Array.isArray(nodes)) return nodes;
  // Drop ephemeral nodes (e.g. comp-source cards spawned during price research)
  // EXCEPT those carrying actionable warning/error state — those represent a
  // paused 'comps-ready' flow the user needs to recover on reload. Without
  // this carve-out, quitting from comps-ready would persist the hub (with
  // pendingComps and scrapeWarnings) but strip the cards that hold the
  // Solve/Skip buttons, leaving the user no way to act.
  const filtered = nodes.filter(n => {
    const isEphemeral = n.type === 'compsourcecard' || n.type === 'jobsourcecard' || n.data?.ephemeral;
    if (!isEphemeral) return true;
    const p = n.data?.persistedProgress;
    return !!(p?.warning || p?.status === 'error');
  });
  return filtered.map(n => {
    // Recurse into nested canvas nodes first so deeply-nested nodes are also sanitized.
    // Also strip all transient data fields (isDropTarget, _hmr) from this group node.
    if (n.type === 'group' && n.data?.canvasData) {
      const sanitizedInner = sanitizeNodesForSave(n.data.canvasData.nodes || []);
      const { isDropTarget: _idt, _hmr: _h, ...cleanData } = n.data || {};
      return {
        ...n,
        data: {
          ...cleanData,
          canvasData: { ...n.data.canvasData, nodes: sanitizedInner },
        },
      };
    }

    // For all node types: strip transient display state in a single pass.
    // - isDropTarget: drag-hover highlight set by DnD handlers, never saved.
    // - _hmr: HMR invalidation token set by the dev-only HMR hook, never saved.
    // - style.opacity (jobcard only): set transiently by toggleSourceFilter.
    const hasTransientData = n.data && ('isDropTarget' in n.data || '_hmr' in n.data);
    const hasTransientOpacity = n.type === 'jobcard' && n.style?.opacity !== undefined;

    // Reset stuck *processing* states so hubs auto-restart gracefully on reload.
    // 'sources-ready' is intentionally NOT in this list: it's the paused JobHub
    // state (search ran, user hasn't resolved/skipped blocked sources yet) and
    // is preserved across reload — like SellHub's 'comps-ready' — so the user
    // can resume. Its recovery buffers (pendingJobs / scrapeWarnings) are kept
    // by the conditional key list below; only the error banner is stripped.
    const isJobHub = n.type === 'jobhub';
    const isSellHub = n.type === 'sellhub';
    const isHub = isJobHub || isSellHub;
    const hasTransientHubState = isHub && n.data && TRANSIENT_PROCESSING_HUB_STATES.includes(n.data.hubState);

    // Hub-specific transient data fields. These are diagnostic / pending-flow
    // state generated within a single session — once the app restarts the
    // user has no context for them, and persisting them surfaces stale
    // "report an issue" banners from runs they don't remember. Stripping on
    // save means the same-session experience is unchanged (the fields live
    // in React state until the next save) but a fresh session loads clean.
    const JOBHUB_TRANSIENT_KEYS = getJobHubTransientKeysForSave(n.data?.hubState);
    const hasJobHubTransient = isJobHub && n.data && JOBHUB_TRANSIENT_KEYS.some(k => k in n.data);

    // SellHub: platformFitPending gates the marketplace list on the in-flight
    // fit-assessment AI call. It's a within-session UI flag — persisting it true
    // (saved mid-assessment) would reload a priced hub stuck on the "selecting…"
    // spinner with no call running. The fit RESULT (platformFit) is kept; only
    // the pending flag is stripped, so a reloaded priced hub renders its verdicts
    // immediately (or, if none were saved, the unfiltered list).
    const hasSellHubTransient = isSellHub && n.data && SELLHUB_TRANSIENT_KEYS.some(k => k in n.data);

    if (!hasTransientData && !hasTransientOpacity && !hasTransientHubState && !hasJobHubTransient && !hasSellHubTransient) return n;

    let result = n;
    if (hasTransientData || hasTransientHubState || hasJobHubTransient || hasSellHubTransient) {
      const { isDropTarget: _idt, _hmr: _h, ...cleanData } = result.data || {};
      if (hasTransientHubState) cleanData.hubState = 'empty';
      if (hasJobHubTransient) {
        for (const k of JOBHUB_TRANSIENT_KEYS) delete cleanData[k];
      }
      if (hasSellHubTransient) {
        for (const k of SELLHUB_TRANSIENT_KEYS) delete cleanData[k];
      }
      result = { ...result, data: cleanData };
    }
    if (hasTransientOpacity) {
      const { opacity: _opacity, ...restStyle } = result.style || {};
      result = { ...result, style: Object.keys(restStyle).length ? restStyle : undefined };
    }
    return result;
  });
}
