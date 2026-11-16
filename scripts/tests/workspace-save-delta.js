import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import { EventEmitter } from 'node:events';
import electronPkg from 'electron';
import { createCanvasDeltaEncoder, createCanvasDeltaStore } from '../../electron/ipc/workspaceSaveDelta.js';
import { registerFilesystemHandlers } from '../../electron/ipc/filesystem.js';
import { parseWorkspaceText } from '../../electron/ipc/workspaceContentPool.js';
import { createAutosaveSender } from '../../src/hooks/autosaveSender.js';
import { syncStackUpward } from '../../src/utils/navigationUtils.js';
import { sanitizeNodesForSave } from '../../src/utils/serializationUtils.js';
import { buildSyntheticWorkspace, updateCards, measureWholeCanvasSave, measureChangedNodesSave } from '../bench-autosave-handoff.mjs';

// What crossing from the window to the app process does to a value.
const overIpc = value => v8.deserialize(v8.serialize(value));

function saveThrough(encoder, store, data, outcome = 'saved') {
  const { session, root, chunks, settle } = encoder.encode(data);
  const rebuilt = store.resolve(overIpc({ session, root, chunks }));
  settle(rebuilt ? outcome : 'lost');
  return { rebuilt, sent: chunks.length };
}

const text = (id, value) => ({ id, type: 'text', position: { x: 0, y: 0 }, data: { text: value } });
const group = (id, canvasData, extra = {}) => ({ id, type: 'group', position: { x: 1, y: 2 }, data: { label: id, ...extra, canvasData } });

function nestedCanvas() {
  const inner = group('inner', { nodes: [text('deep-1', 'one'), text('deep-2', 'two')], edges: [{ id: 'ie', source: 'deep-1', target: 'deep-2' }], drawings: [], collapsed: true });
  const outer = group('outer', { nodes: [inner, text('mid', 'middle')], edges: [], drawings: [{ id: 'stroke', points: [[0, 0], [1, 1]] }] });
  return { nodes: [text('a', 'first'), outer, text('b', 'second')], edges: [{ id: 'e', source: 'a', target: 'b' }], drawings: [], schemaVersion: 12 };
}

// Replace one node at a path of group ids, leaving every other object as is.
function replaceAt(nodes, pathIds, replace) {
  const [head, ...rest] = pathIds;
  return nodes.map((node) => {
    if (node.id !== head) return node;
    if (!rest.length) return replace(node);
    return { ...node, data: { ...node.data, canvasData: { ...node.data.canvasData, nodes: replaceAt(node.data.canvasData.nodes, rest, replace) } } };
  });
}

function senderEvent() {
  const sender = new EventEmitter();
  sender.id = 9100 + (senderEvent.next += 1);
  sender.isDestroyed = () => false;
  return { sender };
}
senderEvent.next = 0;

export default [
  { name: 'A canvas sent as changed nodes is rebuilt exactly, through edits at every depth', run() {
    const encoder = createCanvasDeltaEncoder();
    const store = createCanvasDeltaStore();
    let data = nestedCanvas();
    const check = (label) => {
      const { rebuilt, sent } = saveThrough(encoder, store, data);
      assert.equal(JSON.stringify(rebuilt), JSON.stringify(data), label);
      return sent;
    };
    assert(check('first save') >= 6, 'the first save sends every node and list');
    assert.equal(check('unchanged canvas'), 0, 'nothing is sent again when nothing changed');

    data = { ...data, nodes: replaceAt(data.nodes, ['a'], node => ({ ...node, data: { text: 'edited' } })) };
    assert.equal(check('top-level edit'), 1);

    const beforeDeepEdit = data;
    data = { ...data, nodes: replaceAt(data.nodes, ['outer', 'inner', 'deep-2'], node => ({ ...node, data: { text: 'deep edit' } })) };
    assert.equal(check('edit two groups down'), 3, 'the edited node and the two groups above it, not their other contents');

    data = { ...data, nodes: [...data.nodes, text('c', 'added')], edges: [...data.edges, { id: 'e2', source: 'b', target: 'c' }] };
    assert.equal(check('added node and edge'), 2);
    data = { ...data, nodes: data.nodes.filter(node => node.id !== 'b').reverse(), edges: [] };
    check('deleted and reordered');
    data = beforeDeepEdit;
    check('undo back to an earlier canvas');
    data = { ...data, nodes: [], edges: [], drawings: [] };
    check('emptied canvas');
  } },

  { name: 'Odd canvas shapes still arrive exactly', run() {
    const shapes = [
      { nodes: [null, text('a', 'x')], edges: [], drawings: [] },
      { nodes: 'not a list', edges: null },
      { nodes: [group('g', null), group('g2', [1, 2]), group('g3', { nodes: 'bad', edges: [{ id: 'kept' }] }), group('g4', { nodes: [text('in', 'x'), 7] })], edges: [], drawings: [] },
      { nodes: [{ id: 'k', type: 'group', data: null }, { id: 'u', data: { list: [undefined, 1], gone: undefined, when: new Date(0) } }], drawings: [] },
      {},
    ];
    for (const data of shapes) {
      const { rebuilt } = saveThrough(createCanvasDeltaEncoder(), createCanvasDeltaStore(), data);
      assert.equal(JSON.stringify(rebuilt), JSON.stringify(data));
      assert.deepEqual(Object.keys(rebuilt), Object.keys(data), 'top-level key order is kept');
    }
    const shared = text('twice', 'same object');
    const sharedEdges = [{ id: 'e' }];
    const data = { nodes: [shared, group('g', { nodes: [shared], edges: sharedEdges, drawings: [] })], edges: sharedEdges, drawings: [] };
    const { rebuilt, sent } = saveThrough(createCanvasDeltaEncoder(), createCanvasDeltaStore(), data);
    assert.equal(JSON.stringify(rebuilt), JSON.stringify(data));
    assert.equal(sent, 5, 'an object used twice is sent once: one node, one group, one edge list, two empty drawing lists');
  } },

  { name: 'The app process never guesses: an unknown key or a damaged request yields no canvas', run() {
    const encoder = createCanvasDeltaEncoder();
    const store = createCanvasDeltaStore();
    const data = nestedCanvas();
    saveThrough(encoder, store, data);

    // The app process lost its copy (it holds nothing for this window).
    const request = encoder.encode(data);
    assert.equal(request.chunks.length, 0);
    assert.equal(createCanvasDeltaStore().resolve(overIpc({ session: request.session, root: request.root, chunks: [] })), null);

    // A reloaded window reuses key names for different nodes.
    const reloaded = createCanvasDeltaEncoder();
    const other = { nodes: [text('z', 'a different canvas')], edges: [], drawings: [] };
    assert.equal(JSON.stringify(saveThrough(reloaded, store, other).rebuilt), JSON.stringify(other), 'a new session starts from nothing');
    assert.equal(store.resolve(overIpc({ session: request.session, root: request.root, chunks: [] })), null, 'the old session is not resurrected');

    for (const bad of [
      null, {}, { session: 's' }, { session: '', root: { value: {} } }, { session: 's', root: { value: [] } },
      { session: 's', root: { value: {}, refs: { nodes: 'k1' } } },
      { session: 's', root: { value: {}, refs: { nodes: [5] } } },
      { session: 's', root: { value: {} }, chunks: 'no' },
      { session: 's', root: { value: {} }, chunks: [['k1']] },
      { session: 's', root: { value: {}, refs: { edges: 'k1' } }, chunks: [['k1', { not: 'a list' }]] },
      { session: 's', root: { value: {}, refs: { nodes: ['k1'] } }, chunks: [['k1', { id: 'g', data: {} }, { nodes: ['k1'] }]] },
      { session: 's', root: { value: {}, refs: { nodes: ['k1'] } }, chunks: [['k1', { id: 'g', data: { canvasData: {} } }, { nodes: ['k2'] }], ['k2', { id: 'h', data: { canvasData: {} } }, { nodes: ['k1'] }]] },
    ]) {
      assert.equal(createCanvasDeltaStore().resolve(bad), null);
    }
    assert.equal(createCanvasDeltaStore().stage({ session: 's', chunks: [['k9', 'text']] }), false);
  } },

  { name: 'After failed saves the window only relies on nodes the app process surely holds', run() {
    const encoder = createCanvasDeltaEncoder();
    const store = createCanvasDeltaStore();
    let data = nestedCanvas();
    saveThrough(encoder, store, data);
    // Each of these saves is rebuilt by the app process and then fails to write.
    for (let round = 0; round < 4; round += 1) {
      data = { ...data, nodes: replaceAt(data.nodes, ['a'], node => ({ ...node, data: { text: `try ${round}` } })) };
      const { rebuilt } = saveThrough(encoder, store, data, 'failed');
      assert.equal(JSON.stringify(rebuilt), JSON.stringify(data), `failed round ${round} still resolved`);
    }
    // A save the app process never saw (refused before it ran), then a normal one.
    encoder.encode({ ...data, nodes: replaceAt(data.nodes, ['b'], node => ({ ...node, data: { text: 'unseen' } })) }).settle('failed');
    const { rebuilt, sent } = saveThrough(encoder, store, data);
    assert.equal(JSON.stringify(rebuilt), JSON.stringify(data));
    assert(sent <= 2, `the unchanged groups were not sent again, sent ${sent}`);
    assert(store.size() < 20, 'nodes no longer on the canvas are dropped');
  } },

  { name: 'Gathering for a save keeps node identity, so unchanged nodes are recognised', run() {
    const level = [text('a', 'one'), text('b', 'two')];
    const stack = [{ nodeId: 'g', nodes: [group('g', { nodes: [], edges: [], drawings: [] }), text('root', 'r')], edges: [], drawings: [] }];
    const copied = syncStackUpward(level, [], [], stack, 0);
    assert.notEqual(copied.nodes[0].data.canvasData.nodes[0], level[0], 'navigation still receives its own copy');
    const shared = syncStackUpward(level, [], [], stack, 0, 0, { clone: false });
    assert.equal(shared.nodes[0].data.canvasData.nodes[0], level[0]);
    assert.equal(JSON.stringify(shared), JSON.stringify(copied), 'both forms hold the same canvas');

    const dimmed = { id: 'card', type: 'jobcard', style: { opacity: 0.2 }, data: { title: 'T', isDropTarget: true } };
    const first = sanitizeNodesForSave([dimmed, level[0]]);
    const second = sanitizeNodesForSave([level[1], dimmed]);
    assert.deepEqual(first[0], { id: 'card', type: 'jobcard', style: undefined, data: { title: 'T' } });
    assert.equal(second[1], first[0], 'the same node yields the same cleaned copy');
    const holder = group('holder', { nodes: [dimmed], edges: [], drawings: [] });
    assert.equal(sanitizeNodesForSave([holder])[0], sanitizeNodesForSave([holder])[0]);
    assert.equal(sanitizeNodesForSave([holder])[0].data.canvasData.nodes[0], first[0]);
    assert.notEqual(sanitizeNodesForSave([{ ...dimmed }])[0], first[0], 'an edited node is cleaned afresh');
  } },

  { name: 'Auto-save sends a large first canvas in small calls, then only what changed', async run() {
    const store = createCanvasDeltaStore();
    const calls = [];
    let written = null;
    const api = {
      stageWorkspaceChunks: async (payload) => { calls.push(['stage', payload.chunks.length]); return { success: store.stage(overIpc(payload)) }; },
      saveWorkspace: async (args) => {
        calls.push([args.canvas ? 'save' : 'whole', args.canvas ? args.canvas.chunks.length : 0]);
        const data = args.canvas ? store.resolve(overIpc(args.canvas)) : overIpc(args.data);
        if (!data) return { success: true, needsFullCanvas: true };
        written = JSON.stringify(data);
        return { success: true, filePath: args.filePath };
      },
    };
    const send = createAutosaveSender();
    let data = { nodes: Array.from({ length: 50 }, (_, i) => text(`n${i}`, `note ${i}`)), edges: [], drawings: [], schemaVersion: 12 };
    const blocks = [];
    let reply = await send({ api, data, filePath: '/w/c.json', onBlocked: ms => blocks.push(ms) });
    assert.equal(reply.filePath, '/w/c.json');
    assert.equal(written, JSON.stringify(data));
    assert(calls.every(([, count]) => count <= 16) && calls.filter(([kind]) => kind === 'stage').length === 3 && calls.at(-1)[0] === 'save',
      `52 records go over 16 at a time, got ${JSON.stringify(calls)}`);
    assert.equal(blocks.length, calls.length + 1, 'every copy out of the window is timed');

    calls.length = 0;
    data = { ...data, nodes: replaceAt(data.nodes, ['n7'], node => ({ ...node, data: { text: 'changed' } })) };
    await send({ api, data, filePath: '/w/c.json' });
    assert.deepEqual(calls, [['save', 1]]);
    assert.equal(written, JSON.stringify(data));

    // The app process lost its copy: the window is asked for the whole canvas.
    calls.length = 0;
    const lost = createCanvasDeltaStore();
    const lostApi = { ...api, saveWorkspace: async (args) => {
      calls.push(args.canvas ? 'save' : 'whole');
      if (args.canvas && !lost.resolve(overIpc(args.canvas))) return { success: true, needsFullCanvas: true };
      written = JSON.stringify(args.canvas ? null : args.data);
      return { success: true, filePath: args.filePath };
    } };
    data = { ...data, nodes: replaceAt(data.nodes, ['n8'], node => ({ ...node, data: { text: 'again' } })) };
    reply = await send({ api: lostApi, data, filePath: '/w/c.json' });
    assert.deepEqual(calls, ['save', 'whole']);
    assert(reply.success && written === JSON.stringify(data));
    // Having lost it once, the next save sends every record again.
    calls.length = 0;
    await send({ api, data, filePath: '/w/c.json' });
    assert.equal(written, JSON.stringify(data));
    assert(calls.filter(([kind]) => kind === 'stage').length === 3);

    // A bridge without the staging call saves the whole canvas as before.
    const plain = [];
    await createAutosaveSender()({ api: { saveWorkspace: async (args) => { plain.push(args); return { success: true, filePath: args.filePath }; } }, data, filePath: '/w/c.json' });
    assert.equal(plain[0].data, data);
  } },

  { name: 'A save by changed nodes writes the same file as a whole-canvas save and reopens identically', async run() {
    const root = await fs.promises.mkdtemp(path.join(process.cwd(), '.ic-save-delta-'));
    const event = senderEvent();
    try {
      electronPkg.ipcMain.__clearInvokeHandlers();
      registerFilesystemHandlers();
      const save = electronPkg.ipcMain.__getInvokeHandler('save-workspace');
      const stage = electronPkg.ipcMain.__getInvokeHandler('stage-workspace-chunks');
      const load = electronPkg.ipcMain.__getInvokeHandler('load-workspace');
      const deltaFile = path.join(root, 'delta.json');
      const wholeFile = path.join(root, 'whole.json');
      const send = createAutosaveSender();
      const api = {
        stageWorkspaceChunks: payload => stage(event, overIpc(payload)),
        saveWorkspace: args => save(event, overIpc(args)),
      };
      const longText = `${'repeated listing text '.repeat(200)}`;
      let data = nestedCanvas();
      data.nodes.push({ id: 'file', type: 'file', data: { filePath: path.join(root, 'notes.txt') } },
        { id: 'job-1', type: 'jobcard', data: { description: longText } }, { id: 'job-2', type: 'jobcard', data: { description: longText } });
      for (let round = 0; round < 4; round += 1) {
        const reply = await send({ api, data, filePath: deltaFile });
        assert(reply?.success === true && reply.filePath === deltaFile, `save ${round} failed: ${reply?.error}`);
        const whole = await save(event, { data: overIpc(data), filePath: wholeFile });
        assert(whole?.success === true, `whole save ${round} failed: ${whole?.error}`);
        const [deltaBytes, wholeBytes] = await Promise.all([fs.promises.readFile(deltaFile, 'utf8'), fs.promises.readFile(wholeFile, 'utf8')]);
        assert.equal(deltaBytes, wholeBytes, `round ${round}: both saves write the same bytes`);
        assert.match(parseWorkspaceText(deltaBytes).nodes.find(node => node.id === 'file').data.relativeFilePath, /notes\.txt$/, 'the app process still adds the portable path');
        const reopened = await load(event, { filePath: deltaFile });
        const reopenedWhole = await load(event, { filePath: wholeFile });
        assert.equal(JSON.stringify(reopened.data), JSON.stringify(reopenedWhole.data), `round ${round}: both files reopen as the same canvas`);
        data = { ...data, nodes: replaceAt(data.nodes, ['outer', 'inner', 'deep-1'], node => ({ ...node, data: { text: `round ${round}` } })) };
        data = { ...data, nodes: replaceAt(data.nodes, ['job-2'], node => ({ ...node, data: { ...node.data, score: round } })) };
      }
      const before = await fs.promises.readFile(deltaFile, 'utf8');
      const unknown = await save(senderEvent(), { canvas: { session: 'elsewhere', root: { value: {}, refs: { nodes: ['k1'] } }, chunks: [] }, filePath: deltaFile });
      assert(unknown?.needsFullCanvas === true && !unknown.filePath, 'an unknown key asks for the whole canvas');
      assert.equal(await fs.promises.readFile(deltaFile, 'utf8'), before, 'and leaves the file untouched');
    } finally {
      event.sender.emit('destroyed');
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  } },

  { name: 'On a 1,159-node workspace an auto-save copies out only the changed cards', run() {
    // Same node count as the 2026-11-16 report at a tenth of its size, so the
    // suite stays quick. scripts/bench-autosave-handoff.mjs runs the full size.
    let state = buildSyntheticWorkspace({ nodeCount: 1159, megabytes: 15 });
    const encoder = createCanvasDeltaEncoder();
    const store = createCanvasDeltaStore();
    const first = measureChangedNodesSave(state, encoder, store);
    assert.equal(JSON.stringify(first.rebuilt), JSON.stringify(first.data));
    state = { ...state, nodes: updateCards(state.nodes, 3, 1) };
    const whole = measureWholeCanvasSave(state);
    const changed = measureChangedNodesSave(state, encoder, store);
    assert.equal(JSON.stringify(changed.rebuilt), JSON.stringify(whole.data), 'the rebuilt canvas is the canvas a whole save would have sent');
    assert.equal(changed.chunks, 4, 'three cards and the group that holds them');
    assert(changed.bytes * 100 < whole.bytes, `changed-node save copied ${changed.bytes} bytes against ${whole.bytes}`);
    assert(changed.gatherMs + changed.handoffMs < 150, `window blocked ${(changed.gatherMs + changed.handoffMs).toFixed(1)} ms`);
  } },
];
