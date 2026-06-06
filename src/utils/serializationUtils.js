import { getNodeDims } from './constants.js';
import {
  getJobSearchTransientKeysForSave,
  SELLHUB_TRANSIENT_KEYS,
  TRANSIENT_PROCESSING_HUB_STATES,
} from './persistenceTransientState.js';
import { stripNonRestorableNodeDataForUndo } from './undoNonRestorableState.js';

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
      const undoData = stripNonRestorableNodeDataForUndo({ ...x, data });
      return { id: x.id, x: x.position?.x, y: x.position?.y, t: x.type, d: undoData, s: x.style, sm: summary };
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
        style: { width: getNodeDims(node).w, height: getNodeDims(node).h },
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

// Fields on a spawned jobcard that reconstruct a scored job (mirrors the scorer
// output / buildJobTree pushCard). Used by the legacy-results migration below.
const JOBCARD_SCORED_FIELDS = [
  'title', 'company', 'location', 'salary', 'snippet', 'matchScore',
  'reasoning', 'careerDirection', 'source', 'url', 'posted', 'language', 'resumeProfile',
];

/**
 * One-time migration for canvases saved BEFORE the Job Search / Job Board split.
 *
 * The OLD Job Search Module (type 'jobhub') spawned its results as on-canvas
 * jobcard/jobgroup nodes. The NEW model stores results in the hub's
 * `data.scoredJobs` and shows no cascade — a Job Board Module displays them. A
 * pre-split hub therefore has the new summary UI but NO `scoredJobs`, so a Job
 * Board reads zero from it and the old cascade floats orphaned beside it.
 *
 * This relocates each legacy hub's results into `data.scoredJobs` (reconstructed
 * from its own jobcards — NO data loss) and drops the now-orphaned cascade
 * (jobcard + jobgroup nodes owned by that hub) so the hub matches the new model.
 * Edges to the dropped nodes are pruned downstream by sanitizeEdgesForSave.
 *
 * Idempotent and tightly gated: only a `jobhub` that has jobcard children AND no
 * stored `scoredJobs` is touched — new-model hubs (scoredJobs present, no
 * children) and every other node are returned unchanged (same array reference
 * when nothing matches, so it's free on already-migrated canvases).
 */
export function migrateLegacyJobHubResults(nodes) {
  if (!Array.isArray(nodes)) return nodes;

  // Map hubId -> its jobcard nodes (canvas order).
  const cardsByHub = new Map();
  for (const n of nodes) {
    if (n.type === 'jobcard' && n.data?.hubId) {
      const arr = cardsByHub.get(n.data.hubId);
      if (arr) arr.push(n); else cardsByHub.set(n.data.hubId, [n]);
    }
  }

  // Legacy hubs = jobhub with cards on canvas but no stored scoredJobs.
  const legacyHubIds = new Set();
  for (const n of nodes) {
    if (n.type === 'jobhub'
        && !(Array.isArray(n.data?.scoredJobs) && n.data.scoredJobs.length)
        && cardsByHub.get(n.id)?.length) {
      legacyHubIds.add(n.id);
    }
  }
  if (legacyHubIds.size === 0) return nodes; // nothing to do — untouched

  // Reconstruct scoredJobs per legacy hub (score desc), from its jobcards.
  const scoredByHub = new Map();
  for (const hubId of legacyHubIds) {
    const jobs = (cardsByHub.get(hubId) || []).map(card => {
      const d = card.data || {};
      const job = {};
      for (const f of JOBCARD_SCORED_FIELDS) if (d[f] !== undefined) job[f] = d[f];
      return job;
    }).sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
    scoredByHub.set(hubId, jobs);
  }

  // Emit: hubs gain scoredJobs; the orphaned cascade (jobcard/jobgroup owned by a
  // legacy hub) is dropped (its data now lives in the hub's scoredJobs).
  const out = [];
  for (const n of nodes) {
    if ((n.type === 'jobcard' || n.type === 'jobgroup') && legacyHubIds.has(n.data?.hubId)) {
      continue;
    }
    if (n.type === 'jobhub' && legacyHubIds.has(n.id)) {
      out.push({ ...n, data: { ...n.data, scoredJobs: scoredByHub.get(n.id) || [] } });
      continue;
    }
    out.push(n);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Versioned node-migration framework
//
// Saved canvases carry a top-level `schemaVersion`. On load we run every
// migration whose version is greater than the file's version, in order, so an
// old canvas heals itself to the current shape. On save we stamp
// CURRENT_SCHEMA_VERSION. Files saved before versioning existed have no field →
// treated as version 0 → all migrations run.
//
// HOW TO ADD A MIGRATION when you change a component's persisted shape:
//   1. Append a `{ version: <next>, name, migrate, selfRecursive? }` entry below.
//      CURRENT_SCHEMA_VERSION advances automatically.
//   2. `migrate(nodes)` takes a flat node array for ONE canvas level and returns
//      a new array (or the SAME ref when nothing matched). Make it:
//        • shape-gated — detect the old shape, ignore already-migrated nodes; and
//        • idempotent — safe to run twice.
//      The runner recurses into nested group canvases for you (unless
//      `selfRecursive: true`, for a step that walks nested data itself, like the
//      group→canvasData migration which BUILDS the nested structure).
//   3. Add a unit test (see scripts/test-runner.js).
// Idempotency is the real safety net: an un-versioned legacy file runs every
// migration, so a step must never corrupt a node it has already converted.
const MIGRATIONS = [
  { version: 1, name: 'group→canvasData',        migrate: migrateGroupNodes,          selfRecursive: true  },
  { version: 2, name: 'legacy-jobhub→scoredJobs', migrate: migrateLegacyJobHubResults, selfRecursive: false },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS.length ? MIGRATIONS[MIGRATIONS.length - 1].version : 0;

/**
 * Apply a single per-level migration to every canvas level: this level, then
 * recursively into each group node's nested `canvasData.nodes`. Returns the same
 * array reference when nothing changed (so clean files pay nothing downstream).
 */
function applyStepRecursive(nodes, migrate) {
  if (!Array.isArray(nodes)) return nodes;
  const atLevel = migrate(nodes);
  let changed = atLevel !== nodes;
  const out = atLevel.map(n => {
    if (n.type === 'group' && Array.isArray(n.data?.canvasData?.nodes)) {
      const inner = applyStepRecursive(n.data.canvasData.nodes, migrate);
      if (inner !== n.data.canvasData.nodes) {
        changed = true;
        return { ...n, data: { ...n.data, canvasData: { ...n.data.canvasData, nodes: inner } } };
      }
    }
    return n;
  });
  return changed ? out : nodes;
}

/**
 * Run all migrations newer than `fromVersion` (the loaded file's schemaVersion;
 * absent ⇒ 0) over `nodes`, in order. Returns the same ref when nothing changed.
 */
export function runNodeMigrations(nodes, fromVersion = 0) {
  if (!Array.isArray(nodes)) return nodes;
  let out = nodes;
  for (const m of MIGRATIONS) {
    if (m.version <= fromVersion) continue;
    out = m.selfRecursive ? m.migrate(out) : applyStepRecursive(out, m.migrate);
  }
  return out;
}

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
    // 'sources-ready' is intentionally NOT in this list: it's the paused Job Search Module
    // state (search ran, user hasn't resolved/skipped blocked sources yet) and
    // is preserved across reload — like SellHub's 'comps-ready' — so the user
    // can resume. Its recovery buffers (pendingJobs / scrapeWarnings) are kept
    // by the conditional key list below; only the error banner is stripped.
    const isJobSearch = n.type === 'jobhub';
    const isSellHub = n.type === 'sellhub';
    const isHub = isJobSearch || isSellHub;
    const hasTransientHubState = isHub && n.data && TRANSIENT_PROCESSING_HUB_STATES.includes(n.data.hubState);

    // Hub-specific transient data fields. These are diagnostic / pending-flow
    // state generated within a single session — once the app restarts the
    // user has no context for them, and persisting them surfaces stale
    // "report an issue" banners from runs they don't remember. Stripping on
    // save means the same-session experience is unchanged (the fields live
    // in React state until the next save) but a fresh session loads clean.
    const JOBSEARCH_TRANSIENT_KEYS = getJobSearchTransientKeysForSave(n.data?.hubState);
    const hasJobSearchTransient = isJobSearch && n.data && JOBSEARCH_TRANSIENT_KEYS.some(k => k in n.data);

    // SellHub: platformFitPending gates the marketplace list on the in-flight
    // fit-assessment AI call. It's a within-session UI flag — persisting it true
    // (saved mid-assessment) would reload a priced hub stuck on the "selecting…"
    // spinner with no call running. The fit RESULT (platformFit) is kept; only
    // the pending flag is stripped, so a reloaded priced hub renders its verdicts
    // immediately (or, if none were saved, the unfiltered list).
    const hasSellHubTransient = isSellHub && n.data && SELLHUB_TRANSIENT_KEYS.some(k => k in n.data);

    if (!hasTransientData && !hasTransientOpacity && !hasTransientHubState && !hasJobSearchTransient && !hasSellHubTransient) return n;

    let result = n;
    if (hasTransientData || hasTransientHubState || hasJobSearchTransient || hasSellHubTransient) {
      const { isDropTarget: _idt, _hmr: _h, ...cleanData } = result.data || {};
      if (hasTransientHubState) cleanData.hubState = 'empty';
      if (hasJobSearchTransient) {
        for (const k of JOBSEARCH_TRANSIENT_KEYS) delete cleanData[k];
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
