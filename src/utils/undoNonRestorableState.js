// Marketplace-card data that must not participate in undo: the price-drop
// reminder clock fields (live), plus the per-card status-check fields the
// Marketplace Status Module retired — kept here so an OLD saved canvas still
// carrying them stays undo-isolated. Stripped from undo fingerprints/snapshots
// and re-merged from the live nodes on restore, so undo/redo never resurrects a
// cleared reminder or rolls one of these background fields back.
const MARKETPLACE_STATUS_FIELDS = [
  'status',
  'statusMessage',
  'lastChecked',
  'attention',
  'lastCheckTrace',
  'lastPriceDropAt',
  'priceDropReminderDue',
];

function isMarketplaceCard(node) {
  return node?.type === 'marketplacecard';
}

function pickNonRestorableData(node) {
  if (!isMarketplaceCard(node) || !node.data) return null;
  const picked = {};
  for (const field of MARKETPLACE_STATUS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(node.data, field)) {
      picked[field] = node.data[field];
    }
  }
  return Object.keys(picked).length ? picked : null;
}

export function stripNonRestorableNodeDataForUndo(node) {
  if (!isMarketplaceCard(node) || !node.data) return node?.data;

  let changed = false;
  const data = { ...node.data };
  for (const field of MARKETPLACE_STATUS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      delete data[field];
      changed = true;
    }
  }
  return changed ? data : node.data;
}

function collectNonRestorableData(nodes, byId) {
  if (!Array.isArray(nodes)) return;

  for (const node of nodes) {
    const picked = pickNonRestorableData(node);
    if (picked && node.id) byId.set(node.id, picked);
    collectNonRestorableData(node?.data?.canvasData?.nodes, byId);
  }
}

function mergeNonRestorableData(nodes, byId) {
  if (!Array.isArray(nodes)) return nodes;

  let changed = false;
  const nextNodes = nodes.map((node) => {
    let nextNode = node;
    const liveData = node?.id ? byId.get(node.id) : null;

    if (liveData && isMarketplaceCard(node)) {
      nextNode = {
        ...nextNode,
        data: {
          ...nextNode.data,
          ...liveData,
        },
      };
      changed = true;
    }

    if (nextNode?.data?.canvasData?.nodes) {
      const childNodes = mergeNonRestorableData(nextNode.data.canvasData.nodes, byId);
      if (childNodes !== nextNode.data.canvasData.nodes) {
        nextNode = {
          ...nextNode,
          data: {
            ...nextNode.data,
            canvasData: {
              ...nextNode.data.canvasData,
              nodes: childNodes,
            },
          },
        };
        changed = true;
      }
    }

    return nextNode;
  });

  return changed ? nextNodes : nodes;
}

export function mergeNonRestorableNodeDataFromLive(restoredNodes, liveNodes) {
  const liveById = new Map();
  collectNonRestorableData(liveNodes, liveById);
  if (liveById.size === 0) return restoredNodes;
  return mergeNonRestorableData(restoredNodes, liveById);
}
