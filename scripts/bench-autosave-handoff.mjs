// Measures how long one auto-save blocks the window on a large workspace,
// the old way (copy the whole canvas out) and the new way (copy only the
// nodes that changed).
//
//   node scripts/bench-autosave-handoff.mjs            1,159 nodes, about 150 MB
//   node scripts/bench-autosave-handoff.mjs 1159 20    node count, megabytes
//
// It runs in plain Node, so "copying out of the window" is stood in for by
// one V8 structured-clone serialization. The real window pays that at least
// once (twice with the context bridge), so the "before" figures here are a
// floor, not the full cost a bug report shows.

import v8 from 'node:v8';
import { pathToFileURL } from 'node:url';
import { syncStackUpward } from '../src/utils/navigationUtils.js';
import { sanitizeNodesForSave, sanitizeEdgesForSave, CURRENT_SCHEMA_VERSION } from '../src/utils/serializationUtils.js';
import { createCanvasDeltaEncoder, createCanvasDeltaStore } from '../electron/ipc/workspaceSaveDelta.js';

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const WORDS = 'posting salary remote hybrid engineer analyst review planning delivery customer platform support quality release schedule budget report team lead senior'.split(' ');

function sentence(random, words) {
  let text = '';
  for (let i = 0; i < words; i += 1) text += `${WORDS[Math.floor(random() * WORDS.length)]}${Math.floor(random() * 1000)} `;
  return text;
}

function jobCard(index, random, bytesPerNode) {
  // About 330 bytes of JSON per requirement row; the rest is one long text.
  const rows = Math.max(1, Math.floor((bytesPerNode * 0.6) / 330));
  const requirements = [];
  for (let i = 0; i < rows; i += 1) {
    requirements.push({
      id: `req-${index}-${i}`,
      text: sentence(random, 12),
      evidence: sentence(random, 10),
      met: random() > 0.5,
      weight: Math.floor(random() * 10),
    });
  }
  let description = '';
  while (description.length < bytesPerNode * 0.4) description += sentence(random, 40);
  return {
    id: `card-${index}`,
    type: 'jobcard',
    position: { x: (index % 40) * 320, y: Math.floor(index / 40) * 260 },
    measured: { width: 300, height: 240 },
    data: { title: `Role ${index}`, company: `Company ${index % 97}`, score: index % 100, description, requirements },
  };
}

/**
 * A workspace shaped like the one in the 2026-11-16 report: the person has
 * opened a group, and that open level holds `nodeCount` nodes.
 * Returns the live open-level state and the navigation stack above it.
 */
export function buildSyntheticWorkspace({ nodeCount = 1159, megabytes = 150, seed = 7 } = {}) {
  const random = seededRandom(seed);
  const bytesPerNode = Math.floor((megabytes * 1024 * 1024) / nodeCount);
  const nodes = [];
  for (let i = 0; i < nodeCount; i += 1) nodes.push(jobCard(i, random, bytesPerNode));
  const edges = [];
  for (let i = 1; i < nodeCount; i += 7) edges.push({ id: `e-${i}`, source: `card-${i - 1}`, target: `card-${i}` });
  const drawings = [{ id: 'd-1', points: Array.from({ length: 500 }, (_, i) => [i, i * 2]) }];
  const stack = [{
    nodeId: 'board-group',
    nodes: [
      { id: 'board-group', type: 'group', position: { x: 0, y: 0 }, data: { label: 'Job search', canvasData: { nodes: [], edges: [], drawings: [] } } },
      { id: 'note', type: 'text', position: { x: 400, y: 0 }, data: { text: 'Root note' } },
    ],
    edges: [],
    drawings: [],
  }];
  return { nodes, edges, drawings, stack };
}

/** Replaces `count` cards the way a React state update does. */
export function updateCards(nodes, count, round) {
  const next = nodes.slice();
  for (let i = 0; i < count; i += 1) {
    const at = (round * 31 + i * 197) % next.length;
    next[at] = { ...next[at], data: { ...next[at].data, score: (next[at].data.score + 1) % 100, status: `updated in round ${round}` } };
  }
  return next;
}

function gather(state, { clone }) {
  const raw = syncStackUpward(state.nodes, state.edges, state.drawings, state.stack, state.stack.length - 1, 0, { clone });
  const nodes = sanitizeNodesForSave(raw.nodes);
  return { ...raw, nodes, edges: sanitizeEdgesForSave(raw.edges, nodes), schemaVersion: CURRENT_SCHEMA_VERSION };
}

const timed = (work) => {
  const startedAt = performance.now();
  const value = work();
  return { ms: performance.now() - startedAt, value };
};

/** One old-style auto-save: deep-copy the open level, then copy everything out. */
export function measureWholeCanvasSave(state) {
  const gathered = timed(() => gather(state, { clone: true }));
  const handed = timed(() => v8.serialize({ data: gathered.value, filePath: '/workspace/canvas.json' }));
  return { gatherMs: gathered.ms, handoffMs: handed.ms, bytes: handed.value.length, data: gathered.value };
}

/** One new-style auto-save through `encoder`, rebuilt by `store` as the app process would. */
export function measureChangedNodesSave(state, encoder, store) {
  const gathered = timed(() => gather(state, { clone: false }));
  let request;
  const handed = timed(() => {
    const { session, root, chunks, settle } = encoder.encode(gathered.value);
    request = { settle, wire: v8.serialize({ canvas: { session, root, chunks }, filePath: '/workspace/canvas.json' }), chunks: chunks.length };
  });
  const rebuilt = store.resolve(v8.deserialize(request.wire).canvas);
  request.settle(rebuilt ? 'saved' : 'lost');
  return { gatherMs: gathered.ms, handoffMs: handed.ms, bytes: request.wire.length, chunks: request.chunks, data: gathered.value, rebuilt };
}

function main() {
  const nodeCount = Number(process.argv[2]) || 1159;
  const megabytes = Number(process.argv[3]) || 150;
  const rounds = 5;
  const fixed = ms => `${ms.toFixed(1)} ms`;
  const megabytesOf = bytes => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

  let state = buildSyntheticWorkspace({ nodeCount, megabytes });
  console.log(`Workspace: ${nodeCount} nodes on the open level, ${megabytesOf(JSON.stringify(gather(state, { clone: false })).length)} as text. Three cards change between saves.\n`);

  console.log('BEFORE (whole canvas copied on every auto-save)');
  let worstBefore = 0;
  for (let round = 1; round <= rounds; round += 1) {
    state = { ...state, nodes: updateCards(state.nodes, 3, round) };
    const run = measureWholeCanvasSave(state);
    worstBefore = Math.max(worstBefore, run.gatherMs + run.handoffMs);
    console.log(`  save ${round}: gather ${fixed(run.gatherMs)}, hand over ${fixed(run.handoffMs)} (${megabytesOf(run.bytes)}), window blocked ${fixed(run.gatherMs + run.handoffMs)}`);
  }

  console.log('\nAFTER (only changed nodes copied)');
  const encoder = createCanvasDeltaEncoder();
  const store = createCanvasDeltaStore();
  const first = measureChangedNodesSave(state, encoder, store);
  console.log(`  first save after opening: ${first.chunks} records, ${megabytesOf(first.bytes)} in all, sent 16 records per call so no single call copies more than about ${megabytesOf((first.bytes / first.chunks) * 16)}`);
  let worstAfter = 0;
  for (let round = 1; round <= rounds; round += 1) {
    state = { ...state, nodes: updateCards(state.nodes, 3, 100 + round) };
    const run = measureChangedNodesSave(state, encoder, store);
    if (JSON.stringify(run.rebuilt) !== JSON.stringify(run.data)) throw new Error('The rebuilt canvas differs from the canvas that was saved.');
    worstAfter = Math.max(worstAfter, run.gatherMs + run.handoffMs);
    console.log(`  save ${round}: gather ${fixed(run.gatherMs)}, hand over ${fixed(run.handoffMs)} (${run.chunks} records, ${megabytesOf(run.bytes)}), window blocked ${fixed(run.gatherMs + run.handoffMs)}`);
  }
  console.log(`\nWorst window block per auto-save: before ${fixed(worstBefore)}, after ${fixed(worstAfter)}. Every rebuilt canvas matched the saved one exactly.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
