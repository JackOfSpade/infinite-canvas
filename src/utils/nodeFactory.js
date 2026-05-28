/**
 * Centralized factory functions for creating node data objects.
 * Eliminates duplicate inline node construction across hooks.
 */

import { generateId } from './idGenerator.js';

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

function createJobHubNode(position, extra = {}) {
  return {
    id: generateId(), type: 'jobhub', position,
    data: { hubState: 'empty', ...extra },
  };
}

function createSellHubNode(position, extra = {}) {
  return {
    id: generateId(), type: 'sellhub', position,
    data: { hubState: 'empty', ...extra },
  };
}

/** Centralized factory lookup — avoids duplicated maps across hooks. */
export const NODE_FACTORIES = {
  text: createTextNode,
  link: createLinkNode,
  group: createGroupNode,
  jobhub: createJobHubNode,
  sellhub: createSellHubNode,
};

// Hub states that indicate an active background job — clones should not inherit these.
const ACTIVE_HUB_STATES = new Set(['parsing', 'querying', 'searching', 'scoring', 'analyzing']);

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
  let src;
  try {
    src = structuredClone(original);
  } catch {
    src = JSON.parse(JSON.stringify(original));
  }

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

  // Sanitize transient AI hub states so the clone is not stuck waiting
  // for an IPC response it didn't initiate.
  if (clone.data?.hubState) {
    if (ACTIVE_HUB_STATES.has(clone.data.hubState)) {
      clone.data.hubState = 'empty';
    } else if (clone.data.hubState === 'researching') {
      clone.data.hubState = 'draft';
    }
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
      // Pass dx=0, dy=0 to preserve exact relative positioning within the sub-canvas
      let newNode = cloneNode(n, 0, 0); 
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
