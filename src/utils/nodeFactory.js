/**
 * Centralized factory functions for creating node data objects.
 * Eliminates duplicate inline node construction across hooks.
 */

import { generateId } from './idGenerator.js';
import { safeClone } from './navigationUtils.js';
import { JOB_COLLECTION_LIMITS_DEFAULT } from './jobCollectionLimits.js';
import { readLastRemoteResidences } from './jobSearchLocations.js';
import { TRANSIENT_PROCESSING_HUB_STATES, getJobSearchTransientKeysForSave } from './persistenceTransientState.js';

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
// with no operation capable of completing it. `sources-ready` and the retired
// `scoring-batch` state are intentionally included even though they are not
// save-sanitized processing states — their recovery controls belong to the
// original hub and its source cards only.
const NONTERMINAL_JOB_HUB_STATES = new Set([
  ...TRANSIENT_PROCESSING_HUB_STATES,
  'sources-ready',
  'scoring-batch',
]);
const CLONED_JOB_HUB_RUN_KEYS = new Set([
  'queuedModuleRun',
  'pendingJobs',
  'pendingTargetRole',
  'pendingCareerData',
  'pendingBatch',
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
]);

function sanitizeJobHubClone(data) {
  const state = data?.hubState;
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

  const clone = {
    ...src,
    id: generateId(),
    position: { x: original.position.x + dx, y: original.position.y + dy },
    selected: true,
  };

  // Clear flags that should not carry over from source
  if (clone.data) {
    clone.data.isNew = false;
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
  if (node.type !== 'group' || !node.data?.canvasData) return node;

  const idMap = new Map();
  const getMappedId = (oldId) => {
    if (!idMap.has(oldId)) idMap.set(oldId, generateId());
    return idMap.get(oldId);
  };

  const processCanvasData = (canvasData) => {
    if (!canvasData) return canvasData;
    const newNodes = (canvasData.nodes || []).map(n => {
      // Pass dx=0, dy=0 to preserve exact relative positioning within the sub-canvas.
      // cloneNode's `selected: true` is for the node the user acted on; inside a
      // sub-canvas it would make every child of the copy drag and delete together.
      let newNode = { ...cloneNode(n, 0, 0), selected: false };
      newNode.id = getMappedId(n.id); // remap original ID consistently

      if (newNode.type === 'group' && newNode.data?.canvasData) {
        newNode.data = { ...newNode.data, canvasData: processCanvasData(newNode.data.canvasData) };
      }
      return newNode;
    });
    
    const newEdges = (canvasData.edges || []).map(e => ({
      ...e,
      id: generateId(),
      source: idMap.get(e.source) ?? e.source,
      target: idMap.get(e.target) ?? e.target,
    }));
    
    const newDrawings = (canvasData.drawings || []).map(d => d.id ? { ...d, id: generateId() } : d);
    
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
