// Compact Board topology for support-report payloads. Canvas edges are local to
// their immediate node array: flattening grouped canvases before resolving an
// edge can join two imported duplicate ids that never shared a graph.
//
// This runs in the renderer just before IPC, so keep it iterative, bounded, and
// defensive. The main-process FULL diagnostic has its own independently bounded
// renderer; these facts only feed compact JOBS/RECOVERY reconciliation.
const MAX_LEVELS = 256;
const MAX_NODES = 20_000;
const MAX_EDGES = 40_000;

function safeRead(value, key) {
  try { return value?.[key]; }
  catch { return undefined; }
}

function safeArray(value) {
  try { return Array.isArray(value) ? value : null; }
  catch { return null; }
}

function safeArrayLength(value) {
  try {
    const length = value?.length;
    return Number.isSafeInteger(length) && length >= 0 ? length : null;
  } catch {
    return null;
  }
}

function nodeFact(value) {
  if (!value || typeof value !== 'object') return null;
  const id = safeRead(value, 'id');
  const type = safeRead(value, 'type');
  return typeof id === 'string' && id && typeof type === 'string'
    ? { value, id, type, data: safeRead(value, 'data') }
    : null;
}

function arraySample(value, count) {
  if (!safeArray(value) || count <= 0) return [];
  try { return value.slice(0, count); }
  catch { return null; }
}

/**
 * Return per-Board, canvas-local display/connectivity facts without exposing
 * node data. Duplicate ids inside one level deliberately receive no inferred
 * ownership or edge relation; duplicate ids in separate levels remain separate
 * entries with a harmless ordinal scope.
 */
export function collectCompactJobBoardTopology(nodes, edges) {
  const queue = [{ nodes: safeArray(nodes) || [], edges: safeArray(edges) || [], depth: 0, scope: 'root' }];
  const seenCanvasNodes = new WeakSet();
  const boards = [];
  const omissions = new Set();
  let queueIndex = 0;
  let nextScope = 1;
  let inspectedLevels = 0;
  let inspectedNodes = 0;
  let inspectedEdges = 0;

  while (queueIndex < queue.length) {
    if (inspectedLevels >= MAX_LEVELS) {
      omissions.add('canvas-level budget');
      break;
    }
    const level = queue[queueIndex++];
    const levelNodes = safeArray(level.nodes);
    if (!levelNodes) {
      omissions.add('unreadable canvas nodes');
      continue;
    }
    try {
      if (seenCanvasNodes.has(levelNodes)) continue;
      seenCanvasNodes.add(levelNodes);
    } catch {
      omissions.add('unreadable canvas nodes');
      continue;
    }
    inspectedLevels++;

    const remainingNodes = Math.max(0, MAX_NODES - inspectedNodes);
    const levelNodeLength = safeArrayLength(levelNodes);
    if (levelNodeLength == null) {
      omissions.add('unreadable canvas nodes');
      continue;
    }
    const nodeSample = arraySample(levelNodes, remainingNodes);
    if (!nodeSample) {
      omissions.add('unreadable canvas nodes');
      continue;
    }
    if (nodeSample.length < levelNodeLength) omissions.add('node budget');
    inspectedNodes += nodeSample.length;
    const levelBounded = nodeSample.length < levelNodeLength;
    const nodesById = new Map();
    const boardsById = new Map();

    for (const rawNode of nodeSample) {
      const node = nodeFact(rawNode);
      if (!node) continue;
      const peers = nodesById.get(node.id) || [];
      peers.push(node);
      nodesById.set(node.id, peers);
      if (node.type !== 'jobboard') continue;
      const entry = {
        node: rawNode,
        id: node.id,
        scope: level.scope,
        connectedSourceHubIds: [],
        renderedCardCount: 0,
      };
      const boardEntries = boardsById.get(node.id) || [];
      boardEntries.push(entry);
      boardsById.set(node.id, boardEntries);
      boards.push(entry);
    }

    for (const rawNode of nodeSample) {
      const node = nodeFact(rawNode);
      if (!node || node.type !== 'jobcard') continue;
      const owner = safeRead(node.data, 'hubId');
      const owners = typeof owner === 'string' ? boardsById.get(owner) : null;
      if (owners?.length === 1) owners[0].renderedCardCount++;
    }

    const levelEdges = safeArray(level.edges);
    if (!levelEdges) {
      omissions.add('unreadable canvas edges');
    } else {
      const remainingEdges = Math.max(0, MAX_EDGES - inspectedEdges);
      const levelEdgeLength = safeArrayLength(levelEdges);
      if (levelEdgeLength == null) {
        omissions.add('unreadable canvas edges');
      } else {
        const edgeSample = arraySample(levelEdges, remainingEdges);
        if (!edgeSample) {
          omissions.add('unreadable canvas edges');
        } else {
          if (edgeSample.length < levelEdgeLength) omissions.add('edge budget');
          inspectedEdges += edgeSample.length;
          for (const edge of edgeSample) {
            const sourceId = safeRead(edge, 'source');
            const targetId = safeRead(edge, 'target');
            const source = typeof sourceId === 'string' ? nodesById.get(sourceId) : null;
            const target = typeof targetId === 'string' ? nodesById.get(targetId) : null;
            if (source?.length !== 1 || target?.length !== 1) continue;
            const sourceNode = source[0];
            const targetNode = target[0];
            const board = sourceNode.type === 'jobboard' ? sourceNode : targetNode.type === 'jobboard' ? targetNode : null;
            const peer = board === sourceNode ? targetNode : board === targetNode ? sourceNode : null;
            if (!board || (peer.type !== 'jobhub' && peer.type !== 'jobsearch')) continue;
            const owners = boardsById.get(board.id);
            if (owners?.length === 1) owners[0].connectedSourceHubIds.push(peer.id);
          }
        }
      }
    }

    if (!levelBounded) {
      for (const rawNode of nodeSample) {
        const data = safeRead(rawNode, 'data');
        const canvasData = safeRead(data, 'canvasData');
        const childNodes = safeRead(canvasData, 'nodes');
        if (!safeArray(childNodes)) continue;
        const childEdges = safeRead(canvasData, 'edges');
        // The traversal limit must bound queued work as well as inspected work.
        // A wide malicious canvas can otherwise put one child array on each of
        // 20,000 root nodes: only 256 levels would be read, but every child
        // reference would already be retained in this queue.
        if (queue.length >= MAX_LEVELS) {
          omissions.add('canvas-level budget');
          break;
        }
        queue.push({
          nodes: childNodes,
          edges: safeArray(childEdges) || [],
          depth: level.depth + 1,
          scope: `nested canvas ${nextScope++} (depth ${level.depth + 1})`,
        });
      }
    }
  }

  return {
    boards,
    omissions: [...omissions].sort(),
    inspectedLevels,
    inspectedNodes,
    inspectedEdges,
  };
}
