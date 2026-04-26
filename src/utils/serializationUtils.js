import { getNodeDims } from './constants';

/** Stable, pure snapshot fingerprint — no hook needed. */
export function fingerprint(snap) {
  if (!snap || !snap.nodes) return '';
  const n = snap.nodes;
  const e = snap.edges || [];
  const d = snap.drawings || [];
  return JSON.stringify({
    n: n.map(x => {
      // Optimization: skip heavy recursive canvasData for groups in the fingerprint.
      // Changes inside groups are managed by their own local undo/redo stacks.
      // Destructure canvasData out so the serialized object never contains the key at all.
      let data = x.data;
      if (x.type === 'group' && data?.canvasData !== undefined) {
        const { canvasData: _cd, ...rest } = data;
        data = rest;
      }
      return { id: x.id, x: x.position?.x, y: x.position?.y, t: x.type, d: data, s: x.style };
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
export function sanitizeNodesForSave(nodes) {
  if (!Array.isArray(nodes)) return nodes;
  return nodes.map(n => {
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
    
    // Reset stuck processing states so hubs auto-restart gracefully on reload
    const isHub = n.type === 'jobhub' || n.type === 'sellhub';
    const transientHubStates = ['parsing', 'querying', 'searching', 'scoring', 'analyzing', 'researching'];
    const hasTransientHubState = isHub && n.data && transientHubStates.includes(n.data.hubState);

    if (!hasTransientData && !hasTransientOpacity && !hasTransientHubState) return n;

    let result = n;
    if (hasTransientData || hasTransientHubState) {
      const { isDropTarget: _idt, _hmr: _h, ...cleanData } = result.data || {};
      if (hasTransientHubState) cleanData.hubState = 'empty';
      result = { ...result, data: cleanData };
    }
    if (hasTransientOpacity) {
      const { opacity: _opacity, ...restStyle } = result.style || {};
      result = { ...result, style: Object.keys(restStyle).length ? restStyle : undefined };
    }
    return result;
  });
}

