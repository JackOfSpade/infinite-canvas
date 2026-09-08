/**
 * Pure path selection for the optional "move linked files to trash" action.
 * It deliberately works from node snapshots, so it can be called from React
 * Flow's pre-removal onNodesDelete callback without depending on render timing.
 */
function collectDeletedNodeIds(nodes, ids = new Set()) {
  nodes.forEach((node) => {
    if (!node) return;
    if (node.id) ids.add(node.id);
    if (node.data?.canvasData?.nodes) collectDeletedNodeIds(node.data.canvasData.nodes, ids);
    // Old canvases are migrated on load, but preserve this fallback while a
    // deletion callback is handling a legacy in-memory group.
    if (node.data?.nodes) collectDeletedNodeIds(node.data.nodes, ids);
  });
  return ids;
}

function addCandidate(candidates, path, kind) {
  if (!path) return;
  const existing = candidates.get(path);
  // Treat a path as a folder if either representation says it is one. That is
  // deliberately conservative: suppressing a trash offer is always safer than
  // offering to trash a directory which still contains a represented child.
  candidates.set(path, existing?.kind === 'folder' || kind === 'folder'
    ? { path, kind: 'folder' }
    : { path, kind: 'file' });
}

function extractPaths(nodes, candidates) {
  nodes.forEach((node) => {
    if ((node.type === 'document' || node.type === 'listing') && node.data?.filePath) {
      addCandidate(candidates, node.data.filePath, 'file');
    }

    if (node.type === 'listing' && Array.isArray(node.data?.imagePaths)) {
      node.data.imagePaths.forEach((path) => addCandidate(candidates, path, 'file'));
    }

    if (node.type !== 'group') return;
    if (node.data?.filePath) {
      // A group created from a folder drag represents that folder itself.
      addCandidate(candidates, node.data.filePath, 'folder');
      return;
    }
    // Organic sub-canvases own their nested document representations.
    if (node.data?.canvasData?.nodes) extractPaths(node.data.canvasData.nodes, candidates);
    if (node.data?.nodes) extractPaths(node.data.nodes, candidates);
  });
}

function representedPaths(nodes, ignoredNodeIds) {
  const paths = new Set();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || ignoredNodeIds.has(node.id)) continue;
    if ((node.type === 'document' || node.type === 'listing' || node.type === 'group') && node.data?.filePath) {
      paths.add(node.data.filePath);
    }
    if (node.type === 'listing' && Array.isArray(node.data?.imagePaths)) {
      node.data.imagePaths.forEach((path) => {
        if (path) paths.add(path);
      });
    }
  }
  return paths;
}

export function collectSurvivingRepresentedPaths(deletedNodes, allNodes) {
  const deletedNodeIds = collectDeletedNodeIds(Array.isArray(deletedNodes) ? deletedNodes : []);
  return [...representedPaths(allNodes, deletedNodeIds)];
}

function isKnownDescendantPath(path, folderPath) {
  const folder = String(folderPath).replace(/[\\/]+$/, '');
  if (!folder) return false;
  return path.startsWith(`${folder}/`) || path.startsWith(`${folder}\\`);
}

const isEditableTextPath = (path) => /\.(?:md|txt)$/i.test(String(path || ''));

function collectDeletedTextDocumentPaths(nodes, paths = new Set()) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node) continue;
    if (node.type === 'document' && isEditableTextPath(node.data?.filePath)) {
      paths.add(node.data.filePath);
    }
    if (node.data?.canvasData?.nodes) collectDeletedTextDocumentPaths(node.data.canvasData.nodes, paths);
    if (node.data?.nodes) collectDeletedTextDocumentPaths(node.data.nodes, paths);
  }
  return paths;
}

/**
 * Text-document paths still represented after ignoring the complete deleted
 * tree. `allNodes` is normally navigation.enumerateAllNodes(), whose stack
 * handling avoids stale nested snapshots.
 */
export function collectRemainingTextDocumentPaths(deletedNodes, allNodes) {
  const deletedNodeIds = collectDeletedNodeIds(Array.isArray(deletedNodes) ? deletedNodes : []);
  const paths = new Set();
  for (const node of Array.isArray(allNodes) ? allNodes : []) {
    if (deletedNodeIds.has(node?.id)) continue;
    if (node?.type === 'document' && isEditableTextPath(node.data?.filePath)) {
      paths.add(node.data.filePath);
    }
  }
  return [...paths];
}

/**
 * Returns last-reference editable text paths. This makes no claim about path
 * aliases; callers that have a shared-session registry must additionally use
 * its alias-aware inspection before treating a path as orphaned.
 */
export function collectOrphanTextDocumentPaths(deletedNodes, allNodes) {
  const remaining = new Set(collectRemainingTextDocumentPaths(deletedNodes, allNodes));
  return [...collectDeletedTextDocumentPaths(deletedNodes)]
    .filter((path) => !remaining.has(path));
}

/**
 * Returns OS paths eligible for a trash prompt after a canvas deletion.
 * React Flow invokes onNodesDelete before applying controlled node removal, so
 * the complete deleted tree is ignored by ID. A surviving duplicate has a
 * different ID and still protects the exact file path. A known represented
 * child also protects its deleted folder candidate.
 */
export function collectTrashEligiblePaths(deletedNodes, allNodes) {
  const candidates = new Map();
  const deleted = Array.isArray(deletedNodes) ? deletedNodes : [];
  extractPaths(deleted, candidates);
  const deletedNodeIds = collectDeletedNodeIds(deleted);
  const livePaths = representedPaths(allNodes, deletedNodeIds);

  return [...candidates.values()]
    .filter(({ path, kind }) => !livePaths.has(path)
      && (kind !== 'folder' || ![...livePaths].some((livePath) => isKnownDescendantPath(livePath, path))))
    .map(({ path }) => path);
}
