/**
 * Centralized factory functions for creating node data objects.
 * Eliminates duplicate inline node construction across hooks.
 */

export function createTextNode(position) {
  return { id: crypto.randomUUID(), type: 'text', position, data: { text: '', isNew: true } };
}

export function createLinkNode(position, extra = {}) {
  return { id: crypto.randomUUID(), type: 'link', position, data: { url: '', label: '', isNew: true, ...extra } };
}

export function createGroupNode(position) {
  return {
    id: crypto.randomUUID(), type: 'group', position,
    style: { width: 160, height: 160 },
    data: {
      title: '', isNew: true,
      canvasData: { nodes: [], edges: [], drawings: [] },
    },
  };
}

export function createJobHubNode(position, extra = {}) {
  return {
    id: crypto.randomUUID(), type: 'jobhub', position,
    data: { hubState: 'empty', ...extra },
  };
}

export function createSellHubNode(position, extra = {}) {
  return {
    id: crypto.randomUUID(), type: 'sellhub', position,
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
