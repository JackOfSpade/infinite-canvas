import { getNodeDims } from './constants.js';
import { createdAtMsFromCardId } from './priceDropReminder.js';
import {
  getJobSearchTransientKeysForSave,
  JOBBOARD_TRANSIENT_KEYS,
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
  let changed = false;
  const out = nodes.map(node => {
    if (node.type === 'group' && !node.data?.canvasData && (node.data?.nodes || node.data?.edges || node.data?.drawings)) {
      const { nodes: innerNodes, edges: innerEdges, drawings: innerDrawings,
              collapsed: _collapsed, pushedNodes: _pushedNodes, items: _items, ...restData } = node.data;
      const { dragHandle: _dragHandle, ...restNode } = node;
      changed = true;
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
      changed = true;
      current = { ...current, deletable: false };
    }
    // Recurse into existing canvasData for new-format group nodes
    if (current.type === 'group' && current.data?.canvasData?.nodes?.length > 0) {
      const migratedInner = migrateGroupNodes(current.data.canvasData.nodes);
      if (migratedInner !== current.data.canvasData.nodes) {
        changed = true;
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
  return changed ? out : nodes;
}

// Fields on a spawned jobcard that reconstruct a scored job (mirrors the scorer
// output / buildJobTree pushCard). Used by the legacy-results migration below.
const JOBCARD_SCORED_FIELDS = [
  'title', 'company', 'location', 'salary', 'snippet', 'matchScore',
  'reasoning', 'careerDirection', 'requirementAssessments', 'materialGaps',
  'strengths', 'experienceAssessment', 'confidence', 'fitAssessment', 'rawScore',
  'adjustedScore', 'adjustments', 'calibration', 'source', 'url', 'posted',
  'language', 'resumeProfile', 'googleCardUrl', 'applySource', 'originHubId',
  // These arrived after the original on-canvas jobcard shape but can occur in
  // an unversioned/exported legacy canvas. Preserve them during the broad
  // card→hub migration instead of silently turning a preference-filtered or
  // compensation-audited listing into a different downstream result.
  'compensationAssessment', 'preferenceAssessment',
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

/**
 * Stamp `createdAt` on marketplace listing cards saved before the card carried
 * a creation timestamp (the price-drop reminder anchors on it). The card's id
 * embeds its real Date.now() spawn suffix, so existing cards usually recover
 * their TRUE creation date; ids without a plausible timestamp fall back to
 * "now". Shape-gated on the field being absent, so it runs once per card.
 */
export function migrateMarketplaceCardCreatedAt(nodes) {
  if (!Array.isArray(nodes)) return nodes;
  let changed = false;
  const out = nodes.map(n => {
    if (n.type !== 'marketplacecard' || n.data?.createdAt) return n;
    changed = true;
    const fromId = createdAtMsFromCardId(n.id);
    return { ...n, data: { ...n.data, createdAt: new Date(fromId ?? Date.now()).toISOString() } };
  });
  return changed ? out : nodes;
}

/**
 * Retire the old shipped default (10) for a job-search hub's
 * `collectionLimits.pagesPerPlatform`. Both collection limits now default to
 * "All" (null) — see jobCollectionLimits.js — but a hub saved before that
 * change persisted the literal `10` on disk, so without this it would keep
 * paging to the retired 10-page ceiling forever even though a brand-new hub
 * gets `null` (unlimited). Shape-gated on the exact value 10, so it runs once
 * per hub and never touches any other explicit number.
 *
 * Trade-off: a user who deliberately typed 10 is indistinguishable from one
 * who never touched the field, and gets migrated too — accepted, since 10 was
 * the only default this field ever shipped with.
 */
export function migrateJobHubPageCeiling(nodes) {
  if (!Array.isArray(nodes)) return nodes;
  let changed = false;
  const out = nodes.map(n => {
    if (n.type !== 'jobhub' || n.data?.collectionLimits?.pagesPerPlatform !== 10) return n;
    changed = true;
    return { ...n, data: { ...n.data, collectionLimits: { ...n.data.collectionLimits, pagesPerPlatform: null } } };
  });
  return changed ? out : nodes;
}

/**
 * Clear a stranded jobhub preflight drop lock (v5).
 *
 * `inputLocked` is set the moment a career-file drop is accepted, before
 * parsing yields a profile. Saving during that window rewrote hubState to
 * 'empty' but persisted the lock, leaving a hub that refuses new drops, claims
 * "Career files retained" with nothing retained, and hides its Re-run button
 * because `hasReusableCareerProfile` is false. The only escape was deleting the
 * module. The key is stripped on save now; this heals canvases already written.
 *
 * Shape-gated on a lock with NO career input behind it, so a hub that really
 * did accept files keeps its lock. Idempotent: once cleared the node no longer
 * matches.
 */
export function migrateStaleJobHubInputLock(nodes) {
  if (!Array.isArray(nodes)) return nodes;
  let changed = false;
  const out = nodes.map(n => {
    if (n.type !== 'jobhub' || !n.data?.inputLocked) return n;
    const d = n.data;
    const hasItem = (v) => Array.isArray(v) && v.some(Boolean);
    if (d.careerData || d.resumeProfile || d.filePath || hasItem(d.filePaths) || hasItem(d.careerFilePaths)) return n;
    changed = true;
    const { inputLocked: _stranded, ...rest } = d;
    return { ...n, data: rest };
  });
  return changed ? out : nodes;
}

/**
 * Restore job hubs saved by the pre-v6 processing-state sanitizer (v6).
 *
 * An interrupted hiring-fit re-analysis retains its already-scored jobs and
 * career identity, but older saves rewrote its transient `scoring` state to
 * `empty`. That hid a real, recoverable result set behind the first-drop UI.
 * Only heal this exact impossible-for-a-fresh-hub shape; an actually empty hub
 * or a hub with orphaned results but no career identity remains untouched.
 */
export function migrateInterruptedJobHubResults(nodes) {
  if (!Array.isArray(nodes)) return nodes;
  let changed = false;
  const out = nodes.map(n => {
    if (n.type !== 'jobhub' || n.data?.hubState !== 'empty') return n;
    const d = n.data;
    const hasResults = Array.isArray(d.scoredJobs) && d.scoredJobs.length > 0;
    const hasCareerIdentity = !!(
      (d.resumeProfile && typeof d.resumeProfile === 'object')
      || (typeof d.careerData === 'string' && d.careerData.trim())
      || d.filePath
      || (Array.isArray(d.filePaths) && d.filePaths.some(Boolean))
      || (Array.isArray(d.careerFilePaths) && d.careerFilePaths.some(Boolean))
    );
    if (!hasResults || !hasCareerIdentity) return n;
    changed = true;
    return { ...n, data: { ...d, hubState: 'done' } };
  });
  return changed ? out : nodes;
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
  { version: 3, name: 'marketplacecard+createdAt', migrate: migrateMarketplaceCardCreatedAt, selfRecursive: false },
  { version: 4, name: 'jobhub-page-ceiling→all',  migrate: migrateJobHubPageCeiling,   selfRecursive: false },
  { version: 5, name: 'jobhub-stranded-input-lock', migrate: migrateStaleJobHubInputLock, selfRecursive: false },
  { version: 6, name: 'jobhub-interrupted-results→done', migrate: migrateInterruptedJobHubResults, selfRecursive: false },
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
  let changed = false;
  const out = [];
  for (const edge of edges) {
    if (liveIds.has(edge?.source) && liveIds.has(edge?.target)) {
      out.push(edge);
    } else {
      changed = true;
    }
  }
  return changed ? out : edges;
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
  // paused 'comps-ready'/'sources-ready' flow the user needs to recover on
  // reload. Without this carve-out, quitting from a paused state would persist
  // the hub (with pendingJobs/pendingComps and scrapeWarnings) but strip the
  // cards that hold the Solve/Skip buttons, leaving the user no way to act.
  //
  // The carve-out is scoped to hubs that KEEP their run context across the
  // reload: a hub saved mid-run (a TRANSIENT_PROCESSING_HUB_STATE, e.g.
  // 'searching') is reset to 'empty' below with its pendingJobs/scrapeWarnings
  // stripped — persisting its warned cards would orphan Solve buttons over a
  // hub that no longer knows about the run (and the staging sidecar's Resume
  // banner is the real recovery path there). Hub gone entirely → same drop.
  const hubStateById = new Map();
  for (const n of nodes) {
    if (n.type === 'jobhub' || n.type === 'sellhub') hubStateById.set(n.id, n.data?.hubState || 'empty');
  }
  let changed = false;
  const out = [];

  for (const n of nodes) {
    const isEphemeral = n.type === 'compsourcecard' || n.type === 'jobsourcecard' || n.data?.ephemeral;
    if (isEphemeral) {
      const p = n.data?.persistedProgress;
      const keepWarned = p?.warning || p?.status === 'error';
      const hubId = n.data?.hubId;
      const keep = !!keepWarned && (
        !hubId // not hub-owned — keep the old behavior
        || (hubStateById.has(hubId) && !TRANSIENT_PROCESSING_HUB_STATES.includes(hubStateById.get(hubId)))
      );
      if (!keep) {
        changed = true;
        continue;
      }
    }

    // Recurse into nested canvas nodes first so deeply-nested nodes are also sanitized.
    // Also strip all transient data fields from this group node. The rollback
    // receipt is renderer-only state used to rehydrate a source card's local
    // run guard; persisting it would make a later reload look like a rollback.
    if (n.type === 'group' && n.data?.canvasData) {
      const innerNodes = n.data.canvasData.nodes || [];
      const sanitizedInner = sanitizeNodesForSave(innerNodes);
      const {
        isDropTarget: _idt,
        _hmr: _h,
        _boardRollbackProgressRestore: _rollbackProgressRestore,
        ...cleanData
      } = n.data || {};
      const hasTransientData = n.data && (
        'isDropTarget' in n.data
        || '_hmr' in n.data
        || '_boardRollbackProgressRestore' in n.data
      );
      if (hasTransientData || sanitizedInner !== n.data.canvasData.nodes) {
        changed = true;
        out.push({
          ...n,
          data: {
            ...cleanData,
            canvasData: { ...n.data.canvasData, nodes: sanitizedInner },
          },
        });
      } else {
        out.push(n);
      }
      continue;
    }

    // For all node types: strip transient display state in a single pass.
    // - isDropTarget: drag-hover highlight set by DnD handlers, never saved.
    // - _hmr: HMR invalidation token set by the dev-only HMR hook, never saved.
    // - _boardRollbackProgressRestore: in-memory receipt used to restore a
    //   source card's local progress generation after Board cancellation.
    // - style.opacity (jobcard only): set transiently by toggleSourceFilter.
    const hasTransientData = n.data && (
      'isDropTarget' in n.data
      || '_hmr' in n.data
      || '_boardRollbackProgressRestore' in n.data
    );
    const hasTransientOpacity = n.type === 'jobcard' && n.style?.opacity !== undefined;

    // Reset stuck *processing* states so hubs auto-restart gracefully on reload.
    // 'sources-ready' is intentionally NOT in this list: it's the paused Job Search Module
    // state (search ran, user hasn't resolved/skipped blocked sources yet) and
    // is preserved across reload — like SellHub's 'comps-ready' — so the user
    // can resume. Its recovery buffers (pendingJobs / scrapeWarnings) are kept
    // by the conditional key list below; only the error banner is stripped.
    const isJobSearch = n.type === 'jobhub';
    const isJobBoard = n.type === 'jobboard';
    const isSellHub = n.type === 'sellhub';
    const isHub = isJobSearch || isSellHub;
    const hasTransientHubState = isHub && n.data && TRANSIENT_PROCESSING_HUB_STATES.includes(n.data.hubState);
    // A scoring/queued hub can be a re-analysis of results that are already
    // durable on the hub. The in-process restore callback is renderer-only, so
    // on restart the safe terminal state is the previous done card, not an
    // empty card that hides those same results. Fresh searches still have no
    // scoredJobs and follow the normal empty-state recovery path below.
    const hasPersistedJobResults = isJobSearch
      && Array.isArray(n.data?.scoredJobs)
      && n.data.scoredJobs.length > 0;
    // Same idea for SellHub: 'researching' (price research in flight) still
    // has an already-confirmed data.product draft sitting on the node. Mirror
    // resetHandler's own manual-cancel branch (SellHubNode.jsx) so an
    // interrupted save reverts to 'draft', not 'empty' — losing that path
    // would silently re-run the paid AI photo analysis on reload and discard
    // the user's edited draft. 'analyzing'/'queued' never carry a product
    // (that step runs before one exists), so this check alone distinguishes
    // them without needing to inspect hubState directly.
    const hasPersistedSellDraft = isSellHub && !!n.data?.product;

    // Hub-specific transient data fields. These are diagnostic / pending-flow
    // state generated within a single session — once the app restarts the
    // user has no context for them, and persisting them surfaces stale
    // "report an issue" banners from runs they don't remember. Stripping on
    // save means the same-session experience is unchanged (the fields live
    // in React state until the next save) but a fresh session loads clean.
    const JOBSEARCH_TRANSIENT_KEYS = isJobSearch ? getJobSearchTransientKeysForSave(n.data?.hubState) : [];
    const hasJobSearchTransient = isJobSearch && n.data && JOBSEARCH_TRANSIENT_KEYS.some(k => k in n.data);

    // SellHub: platformFitPending gates the marketplace list on the in-flight
    // fit-assessment AI call. It's a within-session UI flag — persisting it true
    // (saved mid-assessment) would reload a priced hub stuck on the "selecting…"
    // spinner with no call running. The fit RESULT (platformFit) is kept; only
    // the pending flag is stripped, so a reloaded priced hub renders its verdicts
    // immediately (or, if none were saved, the unfiltered list).
    const hasSellHubTransient = isSellHub && n.data && SELLHUB_TRANSIENT_KEYS.some(k => k in n.data);
    const hasJobBoardTransient = isJobBoard && n.data && JOBBOARD_TRANSIENT_KEYS.some(k => k in n.data);

    if (!hasTransientData && !hasTransientOpacity && !hasTransientHubState && !hasJobSearchTransient && !hasSellHubTransient && !hasJobBoardTransient) {
      out.push(n);
      continue;
    }

    let result = n;
    if (hasTransientData || hasTransientHubState || hasJobSearchTransient || hasSellHubTransient || hasJobBoardTransient) {
      const {
        isDropTarget: _idt,
        _hmr: _h,
        _boardRollbackProgressRestore: _rollbackProgressRestore,
        ...cleanData
      } = result.data || {};
      if (hasTransientHubState) cleanData.hubState = hasPersistedJobResults ? 'done' : hasPersistedSellDraft ? 'draft' : 'empty';
      if (hasJobSearchTransient) {
        for (const k of JOBSEARCH_TRANSIENT_KEYS) delete cleanData[k];
      }
      if (hasSellHubTransient) {
        for (const k of SELLHUB_TRANSIENT_KEYS) delete cleanData[k];
      }
      if (hasJobBoardTransient) {
        for (const k of JOBBOARD_TRANSIENT_KEYS) delete cleanData[k];
      }
      result = { ...result, data: cleanData };
    }
    if (hasTransientOpacity) {
      const { opacity: _opacity, ...restStyle } = result.style || {};
      result = { ...result, style: Object.keys(restStyle).length ? restStyle : undefined };
    }
    changed = true;
    out.push(result);
  }

  return changed ? out : nodes;
}

/**
 * Deep, persistence-oriented content signature.
 *
 * This is intentionally separate from `fingerprint`, which runs on hot render
 * paths and summarizes nested canvases by counts. Load completion uses this
 * deeper signature once to decide whether it is still safe to mark a freshly
 * loaded workspace clean. It must see edits inside nested canvases, while
 * ignoring ReactFlow-only measurements and selection/drag state that appear
 * during the first render but are not user content.
 */
export function persistenceContentFingerprint(snapshot) {
  const inputNodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  const cleanNodes = sanitizeNodesForSave(inputNodes);
  const inputEdges = Array.isArray(snapshot?.edges) ? snapshot.edges : [];
  const cleanEdges = sanitizeEdgesForSave(inputEdges, cleanNodes);

  const projectEdge = (edge) => {
    if (!edge || typeof edge !== 'object') return edge;
    const { selected: _selected, ...persisted } = edge;
    return persisted;
  };

  const projectNode = (node) => {
    if (!node || typeof node !== 'object') return node;
    const {
      measured: _measured,
      selected: _selected,
      dragging: _dragging,
      resizing: _resizing,
      positionAbsolute: _positionAbsolute,
      ...persisted
    } = node;

    const canvasData = persisted.data?.canvasData;
    if (!canvasData || typeof canvasData !== 'object') return persisted;
    return {
      ...persisted,
      data: {
        ...persisted.data,
        canvasData: {
          ...canvasData,
          nodes: Array.isArray(canvasData.nodes) ? canvasData.nodes.map(projectNode) : [],
          edges: Array.isArray(canvasData.edges) ? canvasData.edges.map(projectEdge) : [],
          drawings: Array.isArray(canvasData.drawings) ? canvasData.drawings : [],
        },
      },
    };
  };

  return JSON.stringify({
    nodes: cleanNodes.map(projectNode),
    edges: cleanEdges.map(projectEdge),
    drawings: Array.isArray(snapshot?.drawings) ? snapshot.drawings : [],
  });
}
