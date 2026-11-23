import assert from 'node:assert/strict';
import {
  parseWorkspaceText,
  poolWorkspaceContent,
  restoreWorkspaceContent,
  WORKSPACE_POOL_KEY,
  WORKSPACE_REF_KEY,
  WORKSPACE_POOLED_HEADER,
  WORKSPACE_SHARED_HEADER,
  WORKSPACE_SHARED_KEY,
  formatPlainWorkspace,
  stringifyWorkspaceSharingValues,
} from '../../electron/ipc/workspaceContentPool.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serializeWorkspaceForSave, serializeWorkspaceForSaveOffThread } from '../../electron/ipc/filesystem.js';
import { performanceDiagnosticsMarkdown } from '../../electron/ipc/perfDiagnostics.js';
import { fingerprint, persistenceContentFingerprint } from '../../src/utils/serializationUtils.js';
import { undoHistoryLimit } from '../../src/utils/undoMemoryBudget.js';

const longText = label => `${label} `.repeat(200);
const roundTrip = data => restoreWorkspaceContent(JSON.parse(JSON.stringify(poolWorkspaceContent(data))));

function repeatedCanvas() {
  const assessment = { matches: [{ detail: longText('match') }], score: 7 };
  const snippet = longText('snippet');
  return {
    schemaVersion: 11,
    nodes: [{
      id: 'hub', type: 'jobhub', data: {
        scoredJobs: [{ title: 'A', snippet, preferenceAssessment: { ...assessment } }],
        preferenceCandidatePool: [{ title: 'A', snippet, preferenceAssessment: { ...assessment } }],
        preferenceEvaluation: { audits: [{ index: 0, matches: assessment.matches.map(item => ({ ...item })) }] },
      },
    }],
    edges: [], drawings: [],
  };
}

// Reads one app-process PERF kind's run count and reason counts from the report.
function perfKind(labelStart) {
  const line = performanceDiagnosticsMarkdown().split('\n').find(row => row.startsWith(`- **${labelStart}`)) || '';
  const count = /:\*\* (\d+) recorded/u.exec(line)?.[1];
  const reasons = Object.fromEntries([...(/by reason: ([^·]+)/u.exec(line)?.[1] || '').matchAll(/([a-z-]+) (\d+)/gu)]
    .map(([, code, n]) => [code, Number(n)]));
  return { line, count: count ? Number(count) : 0, reasons };
}
const POOLED = 'Auto-save: removing repeated content';
const UNPOOLED = 'Auto-save: separate process finished but kept the plain form';
const FAILED = 'Auto-save: separate process failed';

export default [
  { name: 'Canvas pool stores repeated content once and restores the exact saved text', run() {
    const data = repeatedCanvas();
    const plain = JSON.stringify(data);
    const pooled = JSON.stringify(poolWorkspaceContent(data));
    assert.ok(pooled.length < plain.length * 0.6, 'repeats are not stored again');
    assert.equal(pooled.split('snippet snippet snippet').length > 1, true);
    assert.equal(JSON.stringify(restoreWorkspaceContent(JSON.parse(pooled))), plain);
  } },
  { name: 'Restored canvas copies are independent, so editing one job cannot change another', run() {
    const restored = roundTrip(repeatedCanvas());
    const { scoredJobs, preferenceCandidatePool } = restored.nodes[0].data;
    assert.deepEqual(scoredJobs[0].preferenceAssessment, preferenceCandidatePool[0].preferenceAssessment);
    assert.notEqual(scoredJobs[0].preferenceAssessment, preferenceCandidatePool[0].preferenceAssessment);
    scoredJobs[0].preferenceAssessment.matches[0].detail = 'edited';
    assert.notEqual(preferenceCandidatePool[0].preferenceAssessment.matches[0].detail, 'edited');
  } },
  { name: 'Canvas pool keeps JSON meaning for key order, odd values and __proto__ keys', run() {
    const text = longText('value');
    const hostileKey = JSON.parse(`{"__proto__":{"text":${JSON.stringify(text)}},"after":1}`);
    const data = {
      nodes: [
        { a: text, b: 1 }, { b: 1, a: text },
        { skipped: undefined, fn: () => 1, nan: Number.NaN, list: [undefined, Number.POSITIVE_INFINITY], when: new Date(0), repeat: text },
        hostileKey, JSON.parse(JSON.stringify(hostileKey)),
      ],
    };
    const restored = roundTrip(data);
    assert.equal(JSON.stringify(restored), JSON.stringify(data));
    assert.equal(Object.getPrototypeOf(restored.nodes[3]), Object.prototype);
  } },
  { name: 'Canvas pool leaves unrepeated or reserved-key data in the plain form', run() {
    assert.equal(poolWorkspaceContent({ nodes: [{ text: longText('once') }] }), null);
    const collision = { nodes: [{ a: longText('x'), b: longText('x'), c: { [WORKSPACE_REF_KEY]: 0 } }] };
    assert.equal(poolWorkspaceContent(collision), null);
    assert.equal(JSON.parse(serializeWorkspaceForSave(collision)).nodes[0].c[WORKSPACE_REF_KEY], 0);
    assert.equal(WORKSPACE_POOL_KEY in JSON.parse(serializeWorkspaceForSave(collision)), false);
  } },
  { name: 'A plain older canvas loads unchanged, and a damaged or newer pool is refused', run() {
    const older = { nodes: [{ id: 'n' }], edges: [] };
    assert.equal(restoreWorkspaceContent(older), older);
    assert.throws(() => restoreWorkspaceContent({ nodes: [], [WORKSPACE_POOL_KEY]: { version: 2, values: [] } }), /newer or unknown/);
    assert.throws(() => restoreWorkspaceContent({ nodes: [{ [WORKSPACE_REF_KEY]: 5 }], [WORKSPACE_POOL_KEY]: { version: 1, values: [] } }), /broken content reference/);
  } },
  { name: 'A saved canvas with repeats is written pooled and restores to the same content', run() {
    const data = repeatedCanvas();
    const saved = serializeWorkspaceForSave(data);
    assert.equal(JSON.stringify(parseWorkspaceText(saved)), JSON.stringify(data));
    assert.throws(() => JSON.parse(saved), SyntaxError, 'a build without the pool refuses this file instead of saving references back');
  } },
  { name: 'Saving in the worker process writes exactly what saving on the main thread writes', async run() {
    const repeated = repeatedCanvas();
    const pooledBefore = perfKind(POOLED).count;
    const unpooledBefore = perfKind(UNPOOLED).count;
    assert.equal(await serializeWorkspaceForSaveOffThread(repeated), serializeWorkspaceForSave(repeated));
    assert.equal(perfKind(POOLED).count, pooledBefore + 1, 'a pooled save is recorded as pooled');
    const plain = { schemaVersion: 11, nodes: [{ id: 'n', data: { text: 'short' } }], edges: [] };
    assert.equal(await serializeWorkspaceForSaveOffThread(plain), JSON.stringify(plain));
    assert.equal(perfKind(POOLED).count, pooledBefore + 1, 'a plain result is not counted as a pooled save');
    assert.equal(perfKind(UNPOOLED).count, unpooledBefore + 1, 'a plain result has its own PERF kind');
  } },
  { name: 'A save worker that dies (out of memory, crash, timeout) saves the canvas plain and leaves the app running', async run() {
    // 2026-11-22: a save worker *thread* that ran out of memory aborted the whole
    // app, because Electron shares one heap between all threads. The worker is
    // now a separate process; whatever happens to it, this process carries on.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-save-worker-'));
    try {
      const repeated = repeatedCanvas();
      // The fixture shares one `matches` array between two rows, so the plain
      // form writes it once under the v2 header.
      const { text: sharedText, shared } = stringifyWorkspaceSharingValues(repeated);
      const plainText = formatPlainWorkspace(sharedText, { shared });
      const failedBefore = perfKind(FAILED);
      const aborts = path.join(dir, 'aborts.mjs');
      fs.writeFileSync(aborts, "process.stdin.resume(); process.stdin.on('end', () => process.abort());\n");
      assert.equal(await serializeWorkspaceForSaveOffThread(repeated, { workerPath: aborts }), plainText, 'an aborted worker means a plain save');
      const garbled = path.join(dir, 'garbled.mjs');
      fs.writeFileSync(garbled, "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('?'));\n");
      assert.equal(await serializeWorkspaceForSaveOffThread(repeated, { workerPath: garbled }), plainText, 'an unreadable reply means a plain save');
      const stuck = path.join(dir, 'stuck.mjs');
      fs.writeFileSync(stuck, 'setInterval(() => {}, 1000);\n');
      assert.equal(await serializeWorkspaceForSaveOffThread(repeated, { workerPath: stuck, timeoutMs: 300 }), plainText, 'a stuck worker is killed and the save goes out plain');
      assert.equal(await serializeWorkspaceForSaveOffThread(repeated, { workerPath: path.join(dir, 'missing.mjs') }), plainText, 'a missing worker file means a plain save');
      assert.equal(parseWorkspaceText(plainText).nodes.length, repeated.nodes.length, 'the plain save restores the same canvas');
      const failed = perfKind(FAILED);
      assert.equal(failed.count, failedBefore.count + 4, 'every failed process leaves a PERF row');
      const grew = code => (failed.reasons[code] || 0) - (failedBefore.reasons[code] || 0);
      assert.deepEqual({ exit: grew('exit'), 'no-result': grew('no-result'), timeout: grew('timeout'), other: grew('other') },
        { exit: 2, 'no-result': 1, timeout: 1, other: 0 }, 'each failure is filed under its fixed reason');
      assert.match(failed.line, /by reason: /u);
      assert.doesNotMatch(performanceDiagnosticsMarkdown(), /app process because the worker failed|worker thread/u, 'the removed retry and the old worker thread are not described');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } },
  { name: 'An object in several places is written once and loads back as one object', run() {
    // The 2026-11-23 failure: a Board plan held the same 160MB rollback under
    // three keys, so plain JSON wrote it three times and outgrew the string limit.
    const rollback = { version: 1, sourceId: 'hub', previousData: { scoredJobs: [{ title: 'A', snippet: longText('row') }] } };
    const data = {
      nodes: [{ id: 'board', type: 'jobboard', data: { boardScanResume: {
        activeSourceRollback: rollback,
        activeSourceRollbacks: { hub: rollback },
        rescoreFollowUps: { hub: { capability: 'c', rollback } },
      } } }],
      edges: [],
    };
    const plain = JSON.stringify(data);
    const { text, shared } = stringifyWorkspaceSharingValues(data);
    assert.equal(shared, true);
    assert.equal(text.split(longText('row')).length - 1, 1, 'the shared rollback is written once');
    assert(text.length < plain.length / 2);
    const saved = serializeWorkspaceForSave(data);
    assert(saved.startsWith(WORKSPACE_SHARED_HEADER), 'shared values need the v2 header');
    assert.throws(() => JSON.parse(saved), 'a reader without this format refuses the file instead of loading references as data');
    const loaded = parseWorkspaceText(saved);
    assert.equal(JSON.stringify(loaded), plain, 'the loaded canvas is the same canvas');
    const plan = loaded.nodes[0].data.boardScanResume;
    assert.equal(plan.activeSourceRollback, plan.activeSourceRollbacks.hub, 'one object again, as memory held it');
    assert.equal(plan.activeSourceRollback, plan.rescoreFollowUps.hub.rollback);
    assert(!Object.hasOwn(loaded, WORKSPACE_SHARED_KEY));
  } },
  { name: 'Shared values nest, empty and repeated-free canvases stay plain JSON', run() {
    const inner = { text: longText('inner') };
    const outer = { inner, again: inner, label: 'outer' };
    const data = { nodes: [{ a: outer }, { b: outer }, { c: inner }], empty: [], emptyAgain: [] };
    data.emptyAgain = data.empty;
    const { text, shared } = stringifyWorkspaceSharingValues(data);
    assert.equal(shared, true);
    const loaded = parseWorkspaceText(WORKSPACE_SHARED_HEADER + text);
    assert.equal(JSON.stringify(loaded), JSON.stringify(data));
    assert.equal(loaded.nodes[0].a, loaded.nodes[1].b);
    assert.equal(loaded.nodes[0].a.inner, loaded.nodes[2].c);
    assert.equal(loaded.nodes[0].a.inner, loaded.nodes[0].a.again);
    const unshared = { nodes: [{ id: 'x', data: { when: new Date(0), list: [1, 2] } }] };
    assert.deepEqual(stringifyWorkspaceSharingValues(unshared), { text: JSON.stringify(unshared), shared: false });
    assert.equal(serializeWorkspaceForSave(unshared), JSON.stringify(unshared), 'nothing shared, nothing repeated: the file is plain JSON as before');
    const reserved = { nodes: [outer, outer], [WORKSPACE_SHARED_KEY]: 'user data' };
    assert.deepEqual(stringifyWorkspaceSharingValues(reserved), { text: JSON.stringify(reserved), shared: false }, 'a reserved key keeps the plain form');
    assert.throws(() => parseWorkspaceText(`${WORKSPACE_SHARED_HEADER}{"a":{"$canvasShared":3},"${WORKSPACE_SHARED_KEY}":[]}`), /broken shared-value reference/);
  } },
  { name: 'Shared values survive content pooling in the save process and a plain fallback', async run() {
    const rollback = { version: 1, previousData: { pool: [{ snippet: longText('pool') }], other: longText('other') } };
    const data = { nodes: [{ id: 'board', data: { plan: { one: rollback, two: { hub: rollback } } } }, { id: 'hub', data: { pool: [{ snippet: longText('pool') }] } }] };
    const plain = JSON.stringify(data);
    const pooled = await serializeWorkspaceForSaveOffThread(data);
    assert(pooled.startsWith(WORKSPACE_SHARED_HEADER), 'pooled text with shared values carries the v2 header');
    const loaded = parseWorkspaceText(pooled);
    assert.equal(JSON.stringify(loaded), plain);
    assert.equal(loaded.nodes[0].data.plan.one, loaded.nodes[0].data.plan.two.hub);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-shared-'));
    try {
      const fails = path.join(dir, 'fails.mjs');
      fs.writeFileSync(fails, "process.stdin.resume(); process.stdin.on('end', () => process.exit(3));\n");
      const fallback = await serializeWorkspaceForSaveOffThread(data, { workerPath: fails });
      assert(fallback.startsWith(WORKSPACE_SHARED_HEADER) && !fallback.startsWith(WORKSPACE_POOLED_HEADER));
      const back = parseWorkspaceText(fallback);
      assert.equal(JSON.stringify(back), plain);
      assert.equal(back.nodes[0].data.plan.one, back.nodes[0].data.plan.two.hub);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } },
  { name: 'The load-time fingerprint writes a shared object once, like the save', run() {
    const rollback = { version: 1, sourceId: 'hub', previousData: { snippet: longText('fp') } };
    const board = { id: 'board', type: 'jobboard', position: { x: 0, y: 0 }, data: { boardScanResume: {
      activeSourceRollback: rollback, activeSourceRollbacks: { hub: rollback }, rescoreFollowUps: { hub: { rollback } },
    } } };
    const text = persistenceContentFingerprint({ nodes: [board], edges: [], drawings: [] });
    assert.equal(text.split(longText('fp')).length - 1, 1, 'not expanded, so a canvas the save can write the window can also compare');
    const loaded = parseWorkspaceText(serializeWorkspaceForSave({ nodes: [board], edges: [], drawings: [] }));
    assert.equal(persistenceContentFingerprint(loaded), text, 'the reopened canvas fingerprints the same as the one saved');
    const edited = structuredClone(board);
    edited.data.boardScanResume.activeSourceRollback.previousData.snippet += '!';
    assert.notEqual(persistenceContentFingerprint({ nodes: [edited], edges: [], drawings: [] }), text);
  } },
  { name: 'Undo fingerprint and size are remembered per node and still see every edit', run() {
    const card = { id: 'a', type: 'jobcard', position: { x: 0, y: 0 }, data: { description: longText('listing') } };
    const other = { id: 'b', type: 'text', position: { x: 5, y: 5 }, data: { text: 'note' } };
    const before = fingerprint({ nodes: [card, other], edges: [], drawings: [] });
    assert.equal(fingerprint({ nodes: [structuredClone(card), other], edges: [], drawings: [] }), before, 'equal content in a new object fingerprints the same');
    assert.notEqual(fingerprint({ nodes: [{ ...card, position: { x: 1, y: 0 } }, other], edges: [], drawings: [] }), before);
    assert.notEqual(fingerprint({ nodes: [{ ...card, data: { ...card.data, description: `${card.data.description}!` } }, other], edges: [], drawings: [] }), before);
    assert.notEqual(fingerprint({ nodes: [other, card], edges: [], drawings: [] }), before);
    const big = { id: 'big', data: { payload: 'x'.repeat(4 * 1024 * 1024) } };
    const first = undoHistoryLimit({ nodes: [big, other], edges: [], drawings: [] }, 100);
    assert.equal(undoHistoryLimit({ nodes: [big, other], edges: [], drawings: [] }, 100), first);
    assert(first < 100 && undoHistoryLimit({ nodes: [other], edges: [], drawings: [] }, 100) === 100);
  } },

  { name: 'PERF lines say what a save sent, name the stall time basis and label the hand-over accurately', run() {
    const at = Date.UTC(2026, 10, 23, 7, 0, 0);
    const report = performanceDiagnosticsMarkdown({
      observedForMs: 60000, stallObserver: 'active',
      kinds: {
        'save-handoff': { count: 2, worstMs: 12601, recent: [
          { at, ms: 12601, nodes: 872, sent: { records: 3, parts: 2, calls: 1, largest: 'jobhub' } },
          { at: at - 1000, ms: 2, sent: { records: 1, parts: 0, calls: 1, largest: 'secret title' } },
          { at: at - 2000, ms: 3, sent: { records: 0, parts: 0, calls: 2, whole: true } },
        ] },
        stall: { count: 1, worstMs: 400, recent: [{ at, ms: 400 }] },
      },
    });
    assert.match(report, /12601 ms · 872 nodes on the open level · sent 3 records \(2 parts\) in 1 call · largest: jobhub/u);
    assert.match(report, /2 ms · sent 1 record \(0 parts\) in 1 call\n/u, 'a type word outside the list is dropped');
    assert.match(report, /3 ms · sent the whole canvas in 2 calls/u);
    assert.match(report, /Window could not respond[^\n]*newest first · each time is when the stall ended:/u);
    assert.match(report, /longest single blocked stretch/u);
    assert.doesNotMatch(report, /start to confirmed write|does not block\)\n.*start/u);
  } },
];
