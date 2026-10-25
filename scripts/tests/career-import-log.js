import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  careerImportLogFile,
  careerImportReview,
  careerImportStatus,
  compareCareerSources,
  logCareerDataImport,
  readCareerImportHistory,
  readPreviousCareerImportSnapshot,
} from '../../electron/ipc/careerImportLog.js';
import {
  editedPairsSinceSession,
  improvementStatus,
  logGeneratedBundle,
  logSavedBundle,
} from '../../electron/ipc/applicationEditLog.js';
import { evaluateApplicationGenerationGate } from '../../electron/ipc/applicationGenerationGate.js';
import { CAREER_INCREMENTAL_MAX_FILE_BYTES, readCareerIncrementalState, writeCareerIncrementalState } from '../../electron/ipc/careerIncrementalStore.js';
import { compileSyntheticCareerSnapshot } from './careerIncrementalFixture.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const at = day => `2030-01-${String(day).padStart(2, '0')}T00:00:00.000Z`;
const source = (name, text) => ({ name, contentHash: hash(text), text });
const snapshot = (label, sources = [source('Career.txt', 'Original career evidence.')], contract = 'compiler-v1') => ({
  status: 'approved', snapshotId: hash(label), compilationContract: hash(contract),
  inputFingerprint: hash(JSON.stringify(sources.map(({ name, contentHash }) => ({ name, contentHash })))),
  sources,
});
const imported = (root, candidate, run, options = {}) => logCareerDataImport({
  root, snapshot: candidate, canvasScope: '/private/canvas/synthetic.canvas', nodeId: 'search-node',
  module: 'job-search', manualAiRunId: run, now: () => at(1), ...options,
});
async function withRoot(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'career-import-log-'));
  try { return await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
const bundleHtml = text => `<section data-ic-document-panel="resume"><main class="page"><h2>Experience</h2><p>${text}</p></main></section>`;

export default [{
  name: 'career import log: baseline, cached repeat, retry, contract recompile and changed bytes stay distinct',
  run: async () => withRoot(async root => {
    assert.deepEqual(await careerImportStatus(root), { imports: 0, snapshots: 0, startedAt: null, lastProcessedAt: null, lastSourceChangeAt: null });
    const firstSnapshot = snapshot('initial');
    const first = await imported(root, firstSnapshot, 'request-one');
    assert.deepEqual([first.change, first.previousImportId, first.module, first.cacheHit], ['baseline', null, 'job-search', false]);
    const cached = await imported(root, firstSnapshot, 'request-two', { cacheHit: true, now: () => at(2) });
    assert.notEqual(cached.id, first.id, 'a new successful drop is evidence even when its compilation is cached');
    assert.deepEqual([cached.change, cached.previousImportId, cached.cacheHit], ['unchanged', first.id, true]);
    assert.deepEqual(await imported(root, firstSnapshot, 'request-two', { now: () => at(9) }), cached, 'retrying one completed request is idempotent');

    const recompiled = snapshot('new-contract', firstSnapshot.sources, 'compiler-v2');
    const contractEvent = await imported(root, recompiled, 'request-three', { now: () => at(3) });
    assert.equal(contractEvent.change, 'recompiled', 'compiler changes alone do not claim source edits');
    const changed = snapshot('changed-bytes', [source('Career.txt', 'Original career evidence.\nA manually corrected date.')], 'compiler-v2');
    const changedEvent = await imported(root, changed, 'request-four', { now: () => at(4) });
    assert.equal(changedEvent.change, 'source-changed');
    assert.equal(changedEvent.previousImportId, contractEvent.id);
    assert.deepEqual(await careerImportStatus(root), { imports: 4, snapshots: 3, startedAt: at(1), lastProcessedAt: at(4), lastSourceChangeAt: at(4) });
    const history = await readCareerImportHistory(root);
    assert.deepEqual(history.imports.map(item => item.change), ['baseline', 'unchanged', 'recompiled', 'source-changed']);
    assert.equal((await fs.stat(careerImportLogFile(root))).mode & 0o777, 0o600, 'the evidence file is private');
  }),
}, {
  name: 'career import log: concurrent writers preserve all imports and each module scope has its own predecessor',
  run: async () => withRoot(async root => {
    const count = 24;
    const events = await Promise.all(Array.from({ length: count }, (_, index) => imported(root,
      snapshot(`parallel-${index}`, [source('Career.txt', `Synthetic career revision ${index}`)]), `parallel-run-${index}`, {
        nodeId: `node-${index % 4}`, module: index % 2 ? 'job-board' : 'job-search', now: () => at(index + 1),
      })));
    const state = await readCareerImportHistory(root);
    assert.equal(state.imports.length, count);
    assert.equal(state.snapshots.length, count);
    assert.equal(new Set(state.imports.map(item => item.id)).size, count);
    assert.deepEqual(new Set(state.imports.map(item => item.id)), new Set(events.map(item => item.id)));
    for (let scope = 0; scope < 4; scope++) {
      const scopeEvents = events.filter((_item, index) => index % 4 === scope);
      assert.equal(scopeEvents[0].change, 'baseline');
      for (let index = 1; index < scopeEvents.length; index++) {
        assert.equal(scopeEvents[index].previousImportId, scopeEvents[index - 1].id);
        assert.equal(scopeEvents[index].change, 'source-changed');
      }
    }
    const unscoped = await imported(root, snapshot('unscoped'), 'unscoped-run', { canvasScope: null, nodeId: null, module: 'other' });
    assert.deepEqual([unscoped.scopeId, unscoped.module, unscoped.change], [null, 'unknown', 'baseline']);
  }),
}, {
  name: 'career import log: only exact descriptors are persisted, never source text, paths, node names or run ids',
  run: async () => withRoot(async root => {
    const candidate = snapshot('privacy', [{ ...source('Career.txt', 'PRIVATE SOURCE WORDS synthetic profile'), path: '/private/career/Profile.txt', providerRunId: 'private-provider-run' }]);
    await imported(root, candidate, 'private-manual-ai-run', { canvasScope: '/private/canvas/Sensitive.canvas', nodeId: 'private-node-name' });
    const bytes = await fs.readFile(careerImportLogFile(root), 'utf8');
    for (const secret of ['PRIVATE SOURCE WORDS', '/private/career', '/private/canvas', 'private-node-name', 'private-manual-ai-run', 'private-provider-run']) {
      assert(!bytes.includes(secret), `${secret} must not be retained`);
    }
    assert.deepEqual(JSON.parse(bytes).snapshots[0], {
      snapshotId: candidate.snapshotId, inputFingerprint: candidate.inputFingerprint, compilationContract: candidate.compilationContract,
      sources: [{ name: 'Career.txt', contentHash: candidate.sources[0].contentHash }],
    });
    await assert.rejects(imported(root, { ...candidate, status: 'draft' }, 'rejected'), /approved snapshot/);
    await assert.rejects(imported(root, { ...candidate, sources: [{ name: 'Career.txt', contentHash: 'bad' }] }, 'invalid-descriptor'), /exact source descriptors/);
    assert.equal((await careerImportStatus(root)).imports, 1, 'rejected inputs leave the history alone');
  }),
}, {
  name: 'career import reuse: ordered private path lineage crosses modules without reopening edited sources',
  run: async () => withRoot(async root => {
    const original = snapshot('lineage-original');
    const sourcePaths = [path.join(root, 'source', 'Career.txt')];
    const unrelatedPaths = [path.join(root, 'different', 'Career.txt')];
    await fs.mkdir(path.dirname(sourcePaths[0]));
    await fs.writeFile(sourcePaths[0], original.sources[0].text);
    await imported(root, original, 'original-lineage', { sourcePaths });
    const unrelated = snapshot('unrelated-newer', [source('Career.txt', 'Unrelated synthetic person.')]);
    await imported(root, unrelated, 'unrelated-lineage', { nodeId: 'different-node', sourcePaths: unrelatedPaths });
    await fs.writeFile(sourcePaths[0], 'Edited current source, with the original historical words gone.');
    const sourceDescriptors = [source('Career.txt', 'Edited current source, with the original historical words gone.')];
    const calls = [];
    const result = await readPreviousCareerImportSnapshot({
      root, canvasScope: '/another-canvas.canvas', nodeId: 'new-board', sourcePaths, sourceDescriptors,
    }, { loadSnapshot: async (storageRoot, id) => { calls.push([storageRoot, id]); return original; } });
    assert.equal(result, original, 'the same source files can reuse the immutable history from another module');
    assert.equal(result.sources[0].text, 'Original career evidence.', 'the baseline is historical text, not an edited live reread');
    assert.deepEqual(calls, [[path.join(root, 'career-snapshot-store'), original.snapshotId]]);
    const historyText = await fs.readFile(careerImportLogFile(root), 'utf8');
    assert(!historyText.includes(sourcePaths[0]) && !historyText.includes(unrelatedPaths[0]), 'only hashed source paths may be retained');
    assert((await readCareerImportHistory(root)).imports.every(item => /^[a-f0-9]{64}$/.test(item.sourceSetId)));
  }),
}, {
  name: 'career import reuse: legacy lineage requires the immediate same scope and unambiguous ordered names',
  run: async () => withRoot(async root => {
    const original = snapshot('legacy-lineage', [source('Career.txt', 'Prior fact.'), source('Projects.md', 'Prior project.')]);
    const scope = { root, canvasScope: '/private/canvas/synthetic.canvas', nodeId: 'search-node' };
    const changed = original.sources.map(item => source(item.name, `${item.text} Revised.`));
    await imported(root, original, 'legacy-lineage');
    const loaded = [];
    const loadSnapshot = async (_root, id) => { loaded.push(id); return original; };
    assert.equal(await readPreviousCareerImportSnapshot({ ...scope, sourceDescriptors: changed }, { loadSnapshot }), original);
    for (const input of [
      { ...scope, nodeId: 'different-node', sourceDescriptors: changed },
      { ...scope, sourceDescriptors: [...changed].reverse() },
      { ...scope, sourceDescriptors: [changed[0]] },
      { ...scope, sourceDescriptors: [changed[0], source('Renamed.md', 'Project.')] },
    ]) assert.equal(await readPreviousCareerImportSnapshot(input, { loadSnapshot }), null);
    const duplicates = snapshot('legacy-duplicates', [source('Career.txt', 'One.'), source('Career.txt', 'Two.')]);
    await imported(root, duplicates, 'legacy-duplicates');
    assert.equal(await readPreviousCareerImportSnapshot({ ...scope, sourceDescriptors: duplicates.sources }, { loadSnapshot }), null);
    assert.deepEqual(loaded, [original.snapshotId], 'ambiguous or unrelated selections never open snapshots');
  }),
}, {
  name: 'career import reuse: path changes, renamed inputs and invalid current snapshots fall back safely',
  run: async () => withRoot(async root => {
    const original = snapshot('guarded-lineage');
    const sourcePaths = [path.join(root, 'source', 'Career.txt')];
    await imported(root, original, 'guarded-lineage', { sourcePaths });
    const context = { root, canvasScope: '/private/canvas/synthetic.canvas', nodeId: 'search-node', sourcePaths, sourceDescriptors: original.sources };
    assert.equal(await readPreviousCareerImportSnapshot({ ...context, sourcePaths: [path.join(root, 'other', 'Career.txt')] }, { loadSnapshot: async () => original }), null,
      'a logged path digest prevents falling back to names for a different path in the same scope');
    assert.equal(await readPreviousCareerImportSnapshot({ ...context, sourceDescriptors: [source('Renamed.txt', 'Prior fact.')] }, { loadSnapshot: async () => original }), null);
    for (const invalid of [null, { ...original, status: 'draft' }, { ...original, compilationContract: hash('different-contract') },
      { ...original, sources: [source('Career.txt', 'Unrelated source.')] }, { ...original, sources: [{ name: 'Career.txt', contentHash: original.sources[0].contentHash }] }]) {
      assert.equal(await readPreviousCareerImportSnapshot(context, { loadSnapshot: async () => invalid }), null);
    }
    assert.equal(await readPreviousCareerImportSnapshot(context, { loadSnapshot: async () => { throw new Error('corrupt previous snapshot'); } }), null);
    const state = await readCareerImportHistory(root);
    state.imports[0].sourceSetId = 'invalid';
    await fs.writeFile(careerImportLogFile(root), JSON.stringify(state));
    await assert.rejects(readCareerImportHistory(root), /invalid/);
  }),
}, {
  name: 'career compiler reuse storage: verified receipts round-trip privately and invalid replacements preserve valid bytes',
  run: async () => withRoot(async root => {
    const compiled = await compileSyntheticCareerSnapshot();
    assert.equal(await readCareerIncrementalState(root, compiled.snapshot), null);
    const file = await writeCareerIncrementalState(root, compiled.snapshot, compiled.reuseState);
    const bytes = await fs.readFile(file);
    assert.deepEqual(await readCareerIncrementalState(root, compiled.snapshot), compiled.reuseState);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
    await assert.rejects(writeCareerIncrementalState(root, compiled.snapshot, { ...compiled.reuseState, snapshotId: hash('unrelated') }), /does not match/);
    assert.deepEqual(await fs.readFile(file), bytes, 'an invalid receipt must never replace valid optimization state');
    await Promise.all(Array.from({ length: 3 }, () => writeCareerIncrementalState(root, compiled.snapshot, compiled.reuseState)));
    assert.deepEqual(await readCareerIncrementalState(root, compiled.snapshot), compiled.reuseState);
    assert.deepEqual((await fs.readdir(path.dirname(file))).filter(name => name.endsWith('.tmp')), []);
  }),
}, {
  name: 'career compiler reuse storage: corrupt oversized and linked receipts safely disable optimization',
  run: async () => withRoot(async root => {
    const compiled = await compileSyntheticCareerSnapshot();
    const file = await writeCareerIncrementalState(root, compiled.snapshot, compiled.reuseState);
    for (const corrupt of ['{ broken JSON', JSON.stringify({ ...compiled.reuseState, version: 99 })]) {
      await fs.writeFile(file, corrupt);
      assert.equal(await readCareerIncrementalState(root, compiled.snapshot), null);
    }
    await fs.truncate(file, CAREER_INCREMENTAL_MAX_FILE_BYTES + 1);
    assert.equal(await readCareerIncrementalState(root, compiled.snapshot), null, 'oversized receipts are refused before reading their contents');
    await fs.unlink(file);
    const outside = path.join(root, 'outside-receipt.json');
    await fs.writeFile(outside, JSON.stringify(compiled.reuseState));
    await fs.symlink(outside, file);
    assert.equal(await readCareerIncrementalState(root, compiled.snapshot), null);
    await fs.unlink(file);
    await fs.link(outside, file);
    assert.equal(await readCareerIncrementalState(root, compiled.snapshot), null);
    await fs.unlink(file);
    await fs.rmdir(path.dirname(file));
    const outsideDirectory = path.join(root, 'outside-directory');
    await fs.mkdir(outsideDirectory);
    await fs.symlink(outsideDirectory, path.dirname(file));
    assert.equal(await readCareerIncrementalState(root, compiled.snapshot), null);
    await assert.rejects(writeCareerIncrementalState(root, compiled.snapshot, compiled.reuseState), /symbolic link/);
    assert.deepEqual(await fs.readdir(outsideDirectory), [], 'a linked sidecar directory cannot redirect a private write');
  }),
}, {
  name: 'career import log: malformed history and snapshot collisions fail closed without replacing evidence',
  run: async () => withRoot(async root => {
    const initial = snapshot('corruption-initial');
    await imported(root, initial, 'first');
    const valid = await fs.readFile(careerImportLogFile(root), 'utf8');
    await assert.rejects(imported(root, { ...initial, inputFingerprint: hash('identity collision') }, 'collision'), /identity collision/);
    assert.equal(await fs.readFile(careerImportLogFile(root), 'utf8'), valid);
    for (const corrupt of ['{"version":1,not valid json', JSON.stringify({ version: 1, snapshots: [], imports: [{ id: 'orphan', processedAt: at(1), snapshotId: initial.snapshotId }] })]) {
      await fs.writeFile(careerImportLogFile(root), corrupt);
      await assert.rejects(readCareerImportHistory(root));
      await assert.rejects(imported(root, snapshot('after-corruption'), 'after-corruption'));
      assert.equal(await fs.readFile(careerImportLogFile(root), 'utf8'), corrupt, 'a failed append must preserve the corrupt evidence bytes');
    }
  }),
}, {
  name: 'career import review: exact baseline and later source text retain time and scope uncertainty',
  run: async () => withRoot(async root => {
    const beforeFile = source('Career.txt', 'Synthetic original line.\nOriginal date: 2019–2020.');
    const afterFile = source('Career.txt', 'Synthetic original line.\nCorrected date: 2019–2021.');
    const original = snapshot('review-original', [beforeFile]);
    const corrected = snapshot('review-corrected', [afterFile]);
    await imported(root, original, 'original', { now: () => at(1) });
    const matchingScope = await imported(root, corrected, 'corrected', { now: () => at(3) });
    const otherScope = await imported(root, corrected, 'other-node', { nodeId: 'different-board', module: 'job-board', now: () => at(5) });
    const snapshots = new Map([[original.snapshotId, original], [corrected.snapshotId, corrected]]);
    const calls = [];
    const report = await careerImportReview({ root, careerSnapshotId: original.snapshotId, generatedAt: at(2), savedAt: at(4) }, {
      loadSnapshot: async (storageRoot, id) => { calls.push({ storageRoot, id }); return snapshots.get(id); },
    });
    assert.deepEqual(report.baseline, { snapshotId: original.snapshotId, sources: [beforeFile] });
    assert.deepEqual(report.laterImports.map(event => [event.id, event.relationship, event.afterLatestSave]), [
      [matchingScope.id, 'scope-also-processed-original-snapshot', false], [otherScope.id, 'applicability-unknown', true],
    ]);
    assert.deepEqual(report.laterImports[0].sourceChanges, [{ op: 'modified', beforeIndex: 0, afterIndex: 0, before: beforeFile, after: afterFile }]);
    assert.deepEqual(report.laterImports[1].sourceChanges, report.laterImports[0].sourceChanges, 'every import compares to this bundle’s exact original snapshot');
    assert.deepEqual(calls.map(item => item.id), [original.snapshotId, corrected.snapshotId], 'reused snapshot evidence is loaded once');
    assert(calls.every(item => item.storageRoot.startsWith(root)), 'the review loads private snapshot storage under the supplied root');
    assert(report.warnings.some(warning => warning.includes('not module adoption') && warning.includes('resolved')), 'processing evidence never asserts that a hand edit is fixed');
    const bytes = await fs.readFile(careerImportLogFile(root), 'utf8');
    assert(!bytes.includes('Corrected date'), 'read-only reports do not copy source text into the import log');
  }),
}, {
  name: 'career import review: imports during generation are compared from the time its career source was frozen',
  run: async () => withRoot(async root => {
    const beforeFile = source('Career.txt', 'Synthetic source frozen before generation.');
    const afterFile = source('Career.txt', 'Synthetic career correction while the bundle was generating.');
    const original = snapshot('in-flight-original', [beforeFile]);
    const corrected = snapshot('in-flight-corrected', [afterFile]);
    await imported(root, original, 'in-flight-original', { now: () => at(1) });
    const inFlight = await imported(root, corrected, 'in-flight-corrected', { now: () => at(3) });
    const snapshots = new Map([[original.snapshotId, original], [corrected.snapshotId, corrected]]);
    const options = { loadSnapshot: async (_storageRoot, id) => snapshots.get(id) };
    const report = await careerImportReview({ root, careerSnapshotId: original.snapshotId, careerSourceFrozenAt: at(2), generatedAt: at(4), savedAt: at(5) }, options);
    assert.equal(report.careerSourceFrozenAt, at(2));
    assert.equal(report.laterImports.length, 1, 'an import before bundle completion still postdates the source frozen for this bundle');
    assert.equal(report.laterImports[0].id, inFlight.id);
    assert.equal(report.laterImports[0].afterLatestSave, false);
    assert.deepEqual(report.laterImports[0].sourceChanges, [{ op: 'modified', beforeIndex: 0, afterIndex: 0, before: beforeFile, after: afterFile }]);
    for (const careerSourceFrozenAt of [undefined, 'invalid timestamp', at(6)]) {
      const uncertain = await careerImportReview({ root, careerSnapshotId: original.snapshotId, careerSourceFrozenAt, generatedAt: at(4), savedAt: at(5) }, options);
      assert.equal(uncertain.careerSourceFrozenAt, null, 'missing, invalid or post-generation freeze time stays unknown');
      assert.equal(uncertain.laterImports.length, 0, 'legacy fallback cannot silently guess the source-freeze boundary');
      assert(uncertain.warnings.some(warning => /frozen|freeze/i.test(warning)), 'missing or invalid freeze time is explicit uncertainty');
    }
  }),
}, {
  name: 'career import review: legacy bundles, missing snapshots and uncovered history remain explicit',
  run: async () => withRoot(async root => {
    const original = snapshot('uncertain-original');
    const later = snapshot('uncertain-later', [source('Career.txt', 'Synthetic later source')]);
    await imported(root, later, 'later', { now: () => at(3) });
    const legacy = await careerImportReview({ root, generatedAt: at(1), savedAt: at(2) }, { loadSnapshot: () => { throw new Error('legacy bundles cannot choose a snapshot'); } });
    assert.equal(legacy.baseline, null);
    assert.deepEqual(legacy.laterImports, []);
    assert(legacy.warnings.some(warning => warning.includes('legacy') && warning.includes('uncertain')));
    const missingBaseline = await careerImportReview({ root, careerSnapshotId: original.snapshotId, generatedAt: at(1), savedAt: at(2) }, { loadSnapshot: async () => { throw new Error('missing'); } });
    assert.equal(missingBaseline.baseline, null);
    assert(missingBaseline.warnings.some(warning => warning.includes('does not cover')));
    assert(missingBaseline.warnings.some(warning => warning.includes(original.snapshotId) && warning.includes('missing or invalid')));
    const missingLater = await careerImportReview({ root, careerSnapshotId: original.snapshotId, generatedAt: at(1), savedAt: at(2) }, {
      loadSnapshot: async (_storageRoot, id) => id === original.snapshotId ? original : null,
    });
    assert.deepEqual(missingLater.baseline.sources, original.sources);
    assert.equal(missingLater.laterImports.length, 1);
    assert.equal(missingLater.laterImports[0].sourceChanges, null, 'missing evidence cannot imply unchanged source');
    assert.equal(missingLater.laterImports[0].relationship, 'applicability-unknown', 'an unrelated import cannot claim this bundle used its profile');
    assert(missingLater.warnings.some(warning => warning.includes(later.snapshotId) && warning.includes('incomplete')));
  }),
}, {
  name: 'career source comparison: reorder, rename and duplicate descriptors never invent positional lineage',
  run: () => {
    const a = source('A.txt', 'alpha');
    const b = source('B.txt', 'beta');
    assert.deepEqual(compareCareerSources([a, b], [a, b]), []);
    assert.deepEqual(compareCareerSources([a, b], [b, a]).map(change => [change.op, change.beforeIndex, change.afterIndex]), [['reordered', 0, 1], ['reordered', 1, 0]]);
    const renamed = { ...a, name: 'Renamed.txt' };
    assert.deepEqual(compareCareerSources([a], [renamed]), [{ op: 'renamed', beforeIndex: 0, afterIndex: 0, before: a, after: renamed }]);
    const duplicates = [source('Duplicate.txt', 'one'), source('Duplicate.txt', 'two')];
    assert.deepEqual(compareCareerSources(duplicates, [...duplicates].reverse()).map(change => change.op), ['reordered', 'reordered']);
    assert.deepEqual(compareCareerSources([a, a], [a]), [{ op: 'removed', beforeIndex: 1, before: a, after: null }], 'identical duplicate occurrences are not collapsed');
    const changedDuplicate = source('Duplicate.txt', 'three');
    assert.deepEqual(compareCareerSources(duplicates, [duplicates[0], changedDuplicate]).map(change => change.op), ['removed', 'added'], 'duplicate names alone cannot pair changed bytes');
    const sameBytes = [{ ...a, name: 'one.txt' }, { ...a, name: 'two.txt' }];
    assert.deepEqual(compareCareerSources(sameBytes, [{ ...a, name: 'three.txt' }, { ...a, name: 'four.txt' }]).map(change => change.op), ['removed', 'removed', 'added', 'added'], 'duplicate hashes alone cannot identify a renamed file');
  },
}, {
  name: 'career imports: bundle provenance is pinned and later imports never remove edits or clear the generation gate',
  run: async () => withRoot(async root => {
    const frozenAt = '2020-01-02T00:00:00.000Z';
    const original = snapshot('gate-original');
    const corrected = snapshot('gate-corrected', [source('Career.txt', 'Synthetic manually corrected career facts')]);
    await imported(root, original, 'gate-original');
    for (let index = 0; index < 3; index++) {
      const workspaceDir = path.join(root, `bundle-${index}`);
      await logGeneratedBundle({ root, workspaceDir, html: bundleHtml(`Synthetic draft ${index}`), posting: `Synthetic role ${index}`, appVersion: 'test', careerSnapshotId: original.snapshotId, careerSourceFrozenAt: frozenAt });
      await logSavedBundle({ root, workspaceDir, html: bundleHtml(`Synthetic corrected ${index}`) });
    }
    const stateFile = path.join(root, 'application-improvement', 'state.json');
    const before = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert(before.pairs.every(pair => pair.careerSnapshotId === original.snapshotId));
    assert(before.pairs.every(pair => pair.careerSourceFrozenAt === frozenAt), 'each pair retains the moment its exact career input was frozen');
    assert.equal(editedPairsSinceSession(before).length, 3);
    const calls = [];
    const callText = async prompt => {
      calls.push(prompt);
      return { version: 1, patterns: [{ summary: 'Repeated corrections to career facts.', kind: 'truth', bundles: [1, 2, 3] }] };
    };
    assert.equal((await evaluateApplicationGenerationGate({ root, callText })).blocked, true);
    const gated = await fs.readFile(stateFile, 'utf8');
    await imported(root, corrected, 'manual-correction');
    assert.equal(await fs.readFile(stateFile, 'utf8'), gated, 'import evidence cannot rewrite edit pairs, counters, summaries or the stored gate');
    assert.equal(editedPairsSinceSession(JSON.parse(gated)).length, 3);
    const afterGate = await evaluateApplicationGenerationGate({ root, callText });
    assert.deepEqual([afterGate.blocked, afterGate.reason, calls.length], [true, 'cached', 1]);
    assert.equal((await improvementStatus(root)).generationGate.blocked, true);

    const legacy = await logGeneratedBundle({ root, workspaceDir: path.join(root, 'legacy'), html: bundleHtml('Legacy synthetic draft'), appVersion: 'test' });
    const invalid = await logGeneratedBundle({ root, workspaceDir: path.join(root, 'invalid'), html: bundleHtml('Invalid pin synthetic draft'), appVersion: 'test', careerSnapshotId: 'guessed-snapshot', careerSourceFrozenAt: 'invalid timestamp' });
    const future = await logGeneratedBundle({ root, workspaceDir: path.join(root, 'future'), html: bundleHtml('Future freeze synthetic draft'), appVersion: 'test', careerSnapshotId: original.snapshotId, careerSourceFrozenAt: '2099-01-01T00:00:00.000Z' });
    assert.equal(legacy.careerSnapshotId, null, 'missing provenance stays unknown');
    assert.equal(invalid.careerSnapshotId, null, 'invalid provenance stays unknown');
    assert.equal(legacy.careerSourceFrozenAt, null, 'missing source-freeze timing stays unknown');
    assert.equal(invalid.careerSourceFrozenAt, null, 'invalid source-freeze timing stays unknown');
    assert.equal(future.careerSourceFrozenAt, null, 'a source cannot be frozen after the generated bundle was logged');
  }),
}];
