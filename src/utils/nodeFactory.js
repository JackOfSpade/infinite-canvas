/**
 * Centralized factory functions for creating node data objects.
 * Eliminates duplicate inline node construction across hooks.
 */

import { generateId } from './idGenerator.js';
import { safeClone } from './navigationUtils.js';
import { JOB_COLLECTION_LIMITS_DEFAULT } from './jobCollectionLimits.js';
import { readLastRemoteResidences } from './jobSearchLocations.js';
import {
  JOBBOARD_TRANSIENT_KEYS,
  TRANSIENT_PROCESSING_HUB_STATES,
  getJobSearchTransientKeysForSave,
} from './persistenceTransientState.js';
import { remapCopiedJobModuleReferences } from './jobBoardSearchSelection.js';

/**
 * Read the user's last-applied text/link customization from settings so that
 * newly-created text/link nodes inherit it. Falls back to {} on any failure.
 * Storage key matches `useSettings` STORAGE_KEY; field is `lastTextStyle`.
 */
function readLastTextStyle() {
  try {
    const saved = localStorage.getItem('infiniteCanvas.settings');
    if (!saved) return {};
    const parsed = JSON.parse(saved);
    return parsed?.lastTextStyle || {};
  } catch {
    return {};
  }
}

export function createTextNode(position) {
  return {
    id: generateId(),
    type: 'text',
    position,
    data: { text: '', isNew: true, ...readLastTextStyle() },
  };
}

// Internal factories — callers use the NODE_FACTORIES lookup below instead of
// importing these directly. (createTextNode is exported because Canvas.jsx
// calls it directly to side-step the factory map; see its callsite.)
function createLinkNode(position, extra = {}) {
  return {
    id: generateId(),
    type: 'link',
    position,
    data: { url: '', label: '', isNew: true, ...readLastTextStyle(), ...extra },
  };
}

function createGroupNode(position) {
  return {
    id: generateId(), type: 'group', position,
    style: { width: 160, height: 160 },
    data: {
      title: '', isNew: true,
      canvasData: { nodes: [], edges: [], drawings: [] },
    },
  };
}

// Job Search Module. NOTE: the persisted node-type key stays `'jobhub'` (the
// legacy name) so saved canvases keep loading — same backward-compat pattern as
// `group` → CanvasNode. Only the component/UI naming changed to "Job Search".
function createJobSearchNode(position, extra = {}) {
  return {
    id: generateId(), type: 'jobhub', position,
    // Only remote residences are carried into a new module. Search scope,
    // target role, platforms, limits, and every other setting retain factory
    // defaults so one search cannot silently steer the next.
    data: {
      hubState: 'empty',
      collectionLimits: { ...JOB_COLLECTION_LIMITS_DEFAULT },
      searchLocation: { city: '', subdivision: '', country: '', countryCode: null },
      remoteResidences: readLastRemoteResidences(),
      ...extra,
    },
  };
}

function createSellHubNode(position, extra = {}) {
  return {
    id: generateId(), type: 'sellhub', position,
    data: { hubState: 'empty', ...extra },
  };
}

// Marketplace Status Module — monitors all listings on the canvas via each
// platform's notification hub. No file drop, no hubState; it derives everything
// from the marketplace cards already on the canvas + the watch URLs in Settings.
function createMarketplaceStatusNode(position, extra = {}) {
  return {
    id: generateId(), type: 'marketplacestatus', position,
    data: { ...extra },
  };
}

// Job Board: aggregates results from connected Job Search Modules. No file drop
// and no résumé — its inputs arrive purely through edge connections.
function createJobBoardNode(position, extra = {}) {
  return {
    id: generateId(), type: 'jobboard', position,
    data: { hubState: 'empty', ...extra },
  };
}

/** Centralized factory lookup — avoids duplicated maps across hooks. */
export const NODE_FACTORIES = {
  text: createTextNode,
  link: createLinkNode,
  group: createGroupNode,
  jobhub: createJobSearchNode,
  jobboard: createJobBoardNode,
  sellhub: createSellHubNode,
  marketplacestatus: createMarketplaceStatusNode,
};

// A duplicate never owns the original hub's IPC controller, manual-AI run, or
// source-card children.  Preserve completed result data, but never carry a
// nonterminal run state into the clone: it would render as busy/paused forever
// with no operation capable of completing it. `sources-ready` is intentionally
// included even though it is not a save-sanitized processing state — its
// recovery controls belong to the original hub and its source cards only.
const NONTERMINAL_JOB_HUB_STATES = new Set([
  ...TRANSIENT_PROCESSING_HUB_STATES,
  'sources-ready',
]);
const CLONED_JOB_HUB_RUN_KEYS = new Set([
  'queuedModuleRun',
  'pendingJobs',
  'pendingTargetRole',
  'pendingCareerData',
  'activeTargetRole',
  'activeJobPreferences',
  'pendingJobPreferences',
  'pendingJobPreferencesInterpretation',
  'pendingJobPreferencePlan',
  'scrapeWarnings',
  'errorMessage',
  'isRateLimit',
  'rerunOutcome',
  'rerunNotice',
  'manualAiResume',
  'manualAiCleanupReceipts',
  'terminalFinalizationRecovery',
]);
const CLONED_JOB_BOARD_RUN_KEYS = new Set([
  ...JOBBOARD_TRANSIENT_KEYS,
  // Durable only for reopening the same Board. A clone has a new owner id and
  // must never continue the original Board's selected-search transaction.
  'boardScanResume',
  // Unlike a saved Board, a clone cannot resume the original renderer/main-
  // process handoff. Keeping this marker makes the clone replay that run id as
  // soon as it mounts.
  'manualAiResume',
  'boardCancellation',
  'manualAiCleanupReceipts',
]);

function sanitizeJobHubClone(data) {
  // Imported/hand-edited legacy canvases can contain a Job Search node without
  // its usual data object. Duplication must still produce an editable node
  // instead of throwing before React Flow has a chance to repair/render it.
  if (!data || typeof data !== 'object') return;
  const state = data?.hubState;
  // A terminal-looking hub can still carry a durable manual-AI restart marker
  // (for example a saved-result re-analysis). A clone has a new node identity
  // and can never own that original IPC/manual workflow.
  delete data.manualAiResume;
  delete data.manualAiCleanupReceipts;
  delete data.terminalFinalizationRecovery;
  delete data.queuedModuleRun;
  delete data.providerPhaseAwaitingResume;
  // Fresh-import capability is node-scoped user intent, not reusable career
  // data. A copy (including a nested/group copy that later remaps its id) must
  // never be able to start provider work from the original node's import.
  delete data.careerImportGeneration;
  delete data.careerImportFreshCapability;
  delete data.careerImportConsumption;
  if (!NONTERMINAL_JOB_HUB_STATES.has(state)) return;
  const hasCompletedResults = Array.isArray(data.scoredJobs) && data.scoredJobs.length > 0;
  data.hubState = hasCompletedResults ? 'done' : 'empty';
  // The save sanitizer's list is state-sensitive (`sources-ready` retains its
  // recovery buffers), whereas a duplicate must discard those buffers in every
  // nonterminal state. Use both lists so later additions cannot leave a copied
  // manual/preference run stranded.
  for (const key of [...getJobSearchTransientKeysForSave(state), ...CLONED_JOB_HUB_RUN_KEYS]) {
    delete data[key];
  }
  delete data.inputLocked;
}

/**
 * Create a clean, safe clone of an existing node for duplication.
 * - Assigns a new random ID.
 * - Offsets position by (dx, dy) (default: 40x40).
 * - Clears `isNew` so clones don't auto-enter edit mode.
 * - Clears `locked` so duplicated nodes are freely editable.
 * - Sanitizes transient hub states so clones don't inherit in-flight AI jobs.
 *
 * NOTE: canvas-data ID reassignment (nested group nodes) is a separate concern
 * handled by `reassignCanvasDataIDs` below.
 *
 * @param {object} original - The source node object
 * @param {number} [dx=40] - Horizontal offset for the clone
 * @param {number} [dy=40] - Vertical offset for the clone
 * @returns {object} A new node object safe to push into the nodes array
 */
export function cloneNode(original, dx = 40, dy = 40) {
  const src = safeClone(original);
  const originalPosition = original?.position && typeof original.position === 'object'
    ? original.position
    : {};
  const sourceX = Number(originalPosition.x);
  const sourceY = Number(originalPosition.y);
  const offsetX = Number(dx);
  const offsetY = Number(dy);

  const clone = {
    ...src,
    id: generateId(),
    // Position is normally guaranteed by React Flow, but old/imported canvas
    // JSON is user data. A missing or non-finite coordinate used to turn a
    // harmless duplicate into a synchronous crash (or an off-canvas NaN node).
    position: {
      x: (Number.isFinite(sourceX) ? sourceX : 0) + (Number.isFinite(offsetX) ? offsetX : 0),
      y: (Number.isFinite(sourceY) ? sourceY : 0) + (Number.isFinite(offsetY) ? offsetY : 0),
    },
    selected: true,
  };

  // Every known node renderer treats data as an object. Normalizing only an
  // absent/malformed payload preserves ordinary clone data while allowing
  // legacy Job Board/Search nodes to pass the run-state sanitizer below.
  if (!clone.data || typeof clone.data !== 'object' || Array.isArray(clone.data)) {
    clone.data = {};
  }

  // Clear flags that should not carry over from source
  if (clone.data) {
    clone.data.isNew = false;
    // Renderer-only receipt used to restore a source card's local progress
    // guard after an exact Board rollback. A duplicate has no abandoned run
    // to fence and must not replay the receipt under its new identity.
    delete clone.data._boardRollbackProgressRestore;
  }

  // Unlock: clones should always be freely movable/deletable
  if (clone.data?.locked) {
    clone.data.locked = false;
    delete clone.draggable;
    delete clone.deletable;
  }

  // Sanitize transient AI hub states so the clone is not stuck waiting for an
  // IPC response it didn't initiate. Job Search needs its richer run-state
  // cleanup above; Sell Hub retains its existing draft recovery behavior.
  if (clone.type === 'jobhub') {
    sanitizeJobHubClone(clone.data);
  } else if (clone.type === 'jobboard') {
    // A standalone Board clone starts with no edges, so its connection-specific
    // nonempty allow-list cannot be reused. An explicit [] is topology-free
    // user intent (scan none), so retain it; group duplication restores/remaps
    // nonempty selections after every nested node id is allocated below.
    if (!Array.isArray(clone.data.selectedSearchModuleIds)
      || clone.data.selectedSearchModuleIds.length > 0) {
      delete clone.data.selectedSearchModuleIds;
    }
    // Execution order, like a nonempty selection, references the original
    // Board's connections. Group duplication remaps it after every child id is
    // allocated; a standalone Board clone has no compatible Search ids.
    delete clone.data.searchExecutionOrder;
    for (const key of CLONED_JOB_BOARD_RUN_KEYS) delete clone.data[key];
  } else if (clone.data?.hubState) {
    if (clone.data.hubState === 'researching') {
      clone.data.hubState = 'draft';
    } else if (TRANSIENT_PROCESSING_HUB_STATES.includes(clone.data.hubState)) {
      clone.data.hubState = 'empty';
    }
    delete clone.data.queuedModuleRun;
  }

  return clone;
}

/**
 * Recursively remaps all node, edge, and drawing IDs inside a duplicated group's canvasData
 * to prevent ID collisions if identical child nodes are later extracted to a shared parent.
 * Pure function — returns a new object tree; does not mutate the input.
 */
export function reassignCanvasDataIDs(node) {
  if (node?.type !== 'group' || !node.data || !Object.hasOwn(node.data, 'canvasData')) return node;

  const idMap = new Map();
  // Canvas node ids are intended to be unique across the whole nested group
  // tree: a child may later be extracted into an ancestor canvas. Legacy or
  // hand-edited payloads can violate that invariant. Keep the first valid
  // occurrence deterministically; assigning a second clone the same mapped id
  // would create an invalid React Flow canvas, while assigning it a different
  // id would leave every old edge/ownership reference ambiguous.
  const seenOriginalNodeIds = new Set();
  const getMappedId = (oldId) => {
    if (!idMap.has(oldId)) idMap.set(oldId, generateId());
    return idMap.get(oldId);
  };

  const processCanvasData = (canvasData) => {
    // A malformed legacy group payload should become a valid, empty
    // sub-canvas on duplicate. Keeping a string/array/null here lets a later
    // navigation path treat it as a canvas object and either throw or silently
    // discard state outside this repair boundary.
    if (!canvasData || typeof canvasData !== 'object' || Array.isArray(canvasData)) {
      return { nodes: [], edges: [], drawings: [] };
    }
    // Allocate this level's complete node-id map before cloning any node. A
    // Board can precede one of its selected Job Searches in canvas order, so a
    // one-pass map would otherwise have no replacement id available yet.
    // A malformed old clipboard/group must not make duplication unusable. An
    // invalid child cannot participate in an edge/reference remap anyway, so
    // omit only that malformed entry and preserve every valid child.
    const childNodes = Array.isArray(canvasData.nodes)
      ? canvasData.nodes.filter((child) => {
        if (!child
          || typeof child !== 'object'
          || typeof child.id !== 'string'
          || !child.id
          || seenOriginalNodeIds.has(child.id)) return false;
        seenOriginalNodeIds.add(child.id);
        return true;
      })
      : [];
    for (const child of childNodes) {
      if (typeof child?.id === 'string' && child.id) getMappedId(child.id);
    }
    const clonedNodes = childNodes.map(n => {
      // Pass dx=0, dy=0 to preserve exact relative positioning within the sub-canvas.
      // cloneNode's `selected: true` is for the node the user acted on; inside a
      // sub-canvas it would make every child of the copy drag and delete together.
      let newNode = { ...cloneNode(n, 0, 0), selected: false };
      newNode.id = getMappedId(n.id); // remap original ID consistently

      // An own canvasData key means this is a nested sub-canvas even when a
      // malformed legacy value is falsy (null, '', or 0). Normalize it at the
      // same boundary as the parent; only a genuinely absent key stays absent.
      if (newNode.type === 'group' && Object.hasOwn(newNode.data, 'canvasData')) {
        newNode.data = { ...newNode.data, canvasData: processCanvasData(newNode.data.canvasData) };
      }
      return newNode;
    });
    // The full level map is now available, so ownership backlinks, group-tree
    // child ids, Job Card provenance, and Board Search selections can all move
    // to their corresponding copies without retaining aliases to the original
    // module graph.
    const newNodes = remapCopiedJobModuleReferences(
      childNodes,
      clonedNodes,
      idMap,
      Array.isArray(canvasData.edges) ? canvasData.edges : [],
    );
    
    const retainedNodeIds = new Set(newNodes.map(node => node?.id).filter(Boolean));
    const newEdges = (Array.isArray(canvasData.edges) ? canvasData.edges : [])
      .filter(edge => edge && typeof edge === 'object')
      .filter(edge => retainedNodeIds.has(idMap.get(edge.source) ?? edge.source)
        && retainedNodeIds.has(idMap.get(edge.target) ?? edge.target))
      .map(e => ({
      ...e,
      id: generateId(),
      source: idMap.get(e.source) ?? e.source,
      target: idMap.get(e.target) ?? e.target,
      }));
    
    const newDrawings = (Array.isArray(canvasData.drawings) ? canvasData.drawings : [])
      .map(d => d?.id ? { ...d, id: generateId() } : d);
    
    return { nodes: newNodes, edges: newEdges, drawings: newDrawings };
  };

  return {
    ...node,
    data: {
      ...node.data,
      canvasData: processCanvasData(node.data.canvasData),
    },
  };
}
