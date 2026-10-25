/** Private evidence of successfully processed imports, never a claim of module adoption. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDirectoryWithinRoot } from '../utils/pathSafety.js';
import { careerSnapshotStorageRoot, readCareerSnapshot, readPinnedCareerSnapshot } from './careerSnapshot.js';

const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
const importScopeId = (canvasScope, nodeId) => canvasScope && nodeId ? sha([String(canvasScope), String(nodeId)]) : null;
function sourceSetId(sourcePaths) {
  if (!Array.isArray(sourcePaths) || !sourcePaths.length
    || sourcePaths.some(file => typeof file !== 'string' || !path.isAbsolute(file))) return null;
  return sha(sourcePaths.map(file => path.resolve(file)));
}
let queue = Promise.resolve();
function serialize(operation) {
  const result = queue.then(operation);
  queue = result.catch(() => {});
  return result;
}
const fileFor = root => path.join(root, 'application-improvement', 'career-imports.json');

async function directoryFor(root, create = false) {
  const canonicalRoot = await fs.promises.realpath(root);
  const directory = path.join(canonicalRoot, 'application-improvement');
  if (create) return ensureDirectoryWithinRoot(canonicalRoot, directory, { label: 'Career import history' });
  try {
    const stat = await fs.promises.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Career import history must be a private directory.');
    return directory;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function read(root) {
  const directory = await directoryFor(root);
  if (!directory) return { version: 1, startedAt: null, snapshots: [], imports: [] };
  let handle;
  try {
    handle = await fs.promises.open(path.join(directory, 'career-imports.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Career import history must be a regular private file.');
    const state = JSON.parse(await handle.readFile('utf8'));
    if (state?.version !== 1 || !Number.isFinite(Date.parse(state.startedAt)) || !Array.isArray(state.snapshots) || !Array.isArray(state.imports)
      || new Set(state.snapshots.map(item => item?.snapshotId)).size !== state.snapshots.length
      || new Set(state.imports.map(item => item?.id)).size !== state.imports.length
      || state.snapshots.some(item => !HASH.test(item?.snapshotId) || !HASH.test(item?.inputFingerprint) || !HASH.test(item?.compilationContract)
        || !Array.isArray(item?.sources) || !item.sources.length || item.sources.some(source => typeof source?.name !== 'string' || !HASH.test(source?.contentHash)))
      || state.imports.some(item => !item?.id || !Number.isFinite(Date.parse(item.processedAt))
        || !['baseline', 'source-changed', 'recompiled', 'unchanged'].includes(item.change)
        || !['job-search', 'job-board', 'unknown'].includes(item.module)
        || (item.scopeId !== null && !HASH.test(item.scopeId))
        || (item.requestKey !== null && !HASH.test(item.requestKey))
        || (item.sourceSetId != null && !HASH.test(item.sourceSetId))
        || !state.snapshots.some(snapshot => snapshot.snapshotId === item.snapshotId))) {
      throw new Error('Career import history is invalid; the existing evidence was preserved.');
    }
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, startedAt: null, snapshots: [], imports: [] };
    throw error;
  } finally { await handle?.close(); }
}

async function write(root, state) {
  const directory = await directoryFor(root, true);
  const temporary = path.join(directory, `.career-imports-${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporary, path.join(directory, 'career-imports.json'));
    const parent = await fs.promises.open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } finally {
    await handle?.close();
    await fs.promises.unlink(temporary).catch(() => {});
  }
}

function snapshotRecord(snapshot) {
  if (snapshot?.status !== 'approved' || !HASH.test(snapshot.snapshotId)
    || !HASH.test(snapshot.inputFingerprint) || !HASH.test(snapshot.compilationContract)
    || !Array.isArray(snapshot.sources) || !snapshot.sources.length) throw new Error('Career import history requires an approved snapshot.');
  const sources = snapshot.sources.map(source => {
    if (typeof source?.name !== 'string' || !HASH.test(source.contentHash)) throw new Error('Career import history requires exact source descriptors.');
    return { name: source.name, contentHash: source.contentHash };
  });
  return { snapshotId: snapshot.snapshotId, inputFingerprint: snapshot.inputFingerprint, compilationContract: snapshot.compilationContract, sources };
}

/** The host calls this only after all import/audit/cleaning and live-file checks succeed. */
export async function logCareerDataImport({ root, snapshot, canvasScope, nodeId, module, manualAiRunId, sourcePaths, cacheHit = false, now = () => new Date().toISOString() }) {
  const record = snapshotRecord(snapshot);
  const target = ['job-search', 'job-board'].includes(module) ? module : 'unknown';
  // Neither paths nor provider/run IDs are retained in the history.
  const scopeId = importScopeId(canvasScope, nodeId);
  const sourceIdentity = sourcePaths?.length === record.sources.length ? sourceSetId(sourcePaths) : null;
  const requestKey = manualAiRunId ? sha([scopeId, target, String(manualAiRunId), record.snapshotId]) : null;
  return serialize(async () => {
    const state = await read(root);
    const existing = state.snapshots.find(item => item.snapshotId === record.snapshotId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('Career import history snapshot identity collision; existing evidence was preserved.');
    const retry = requestKey && state.imports.find(item => item.requestKey === requestKey);
    if (retry) return retry;
    const previous = scopeId ? state.imports.findLast(item => item.scopeId === scopeId) : null;
    const previousSnapshot = state.snapshots.find(item => item.snapshotId === previous?.snapshotId);
    const change = !previous ? 'baseline' : previousSnapshot.inputFingerprint !== record.inputFingerprint
      ? 'source-changed' : previous.snapshotId !== record.snapshotId ? 'recompiled' : 'unchanged';
    const event = {
      id: crypto.randomUUID(), processedAt: now(), snapshotId: record.snapshotId,
      scopeId, module: target, requestKey, cacheHit: cacheHit === true,
      previousImportId: previous?.id || null, change,
    };
    // File lineage can cross Job Search and Job Board without retaining a
    // source path. Ordered paths distinguish unrelated files with one name.
    if (sourceIdentity) event.sourceSetId = sourceIdentity;
    if (!existing) state.snapshots.push(record);
    state.imports.push(event);
    state.startedAt ||= event.processedAt;
    await write(root, state);
    return event;
  });
}

export async function readCareerImportHistory(root) {
  return serialize(() => read(root));
}

/**
 * Find an approved historical input for these files, never a global latest
 * snapshot. Old logs have no path digest: only their immediate predecessor
 * in this same canvas/module scope with unique ordered names is eligible.
 * The loader reads immutable source text; edited live files are never opened.
 */
export async function readPreviousCareerImportSnapshot({ root, canvasScope, nodeId, sourcePaths, sourceDescriptors }, {
  loadSnapshot = readCareerSnapshot,
} = {}) {
  const descriptors = Array.isArray(sourceDescriptors) ? sourceDescriptors : [];
  if (!descriptors.length || descriptors.some(source => typeof source?.name !== 'string' || !HASH.test(source?.contentHash))) return null;
  if (sourcePaths != null && sourcePaths.length !== descriptors.length) return null;
  const state = await readCareerImportHistory(root);
  const identity = sourceSetId(sourcePaths);
  const scopeId = importScopeId(canvasScope, nodeId);
  const scoped = scopeId ? state.imports.findLast(item => item.scopeId === scopeId) : null;
  const sameOrderedNames = sources => sources?.length === descriptors.length
    && sources.every((source, index) => source.name === descriptors[index].name);
  let previous = identity ? state.imports.findLast(item => item.sourceSetId === identity) : null;
  if (!previous && scoped && scoped.sourceSetId == null) {
    const scopedRecord = state.snapshots.find(item => item.snapshotId === scoped.snapshotId);
    if (sameOrderedNames(scopedRecord?.sources)
      && new Set(descriptors.map(source => source.name)).size === descriptors.length) previous = scoped;
  }
  if (!previous) return null;
  const record = state.snapshots.find(item => item.snapshotId === previous.snapshotId);
  // Names, count and order still guard path-based lineage. A renamed or
  // reordered corpus can safely take the ordinary complete-compile route.
  if (!sameOrderedNames(record?.sources)) return null;
  let snapshot;
  try { snapshot = await loadSnapshot(careerSnapshotStorageRoot(root), record.snapshotId); }
  catch { return null; }
  if (snapshot?.status !== 'approved' || snapshot.snapshotId !== record.snapshotId
    || snapshot.inputFingerprint !== record.inputFingerprint || snapshot.compilationContract !== record.compilationContract
    || !Array.isArray(snapshot.sources) || snapshot.sources.length !== record.sources.length
    || snapshot.sources.some((source, index) => source.name !== record.sources[index].name
      || source.contentHash !== record.sources[index].contentHash || typeof source.text !== 'string')) return null;
  return snapshot;
}

export async function careerImportStatus(root) {
  const state = await readCareerImportHistory(root);
  return {
    imports: state.imports.length, snapshots: state.snapshots.length, startedAt: state.startedAt,
    lastProcessedAt: state.imports.at(-1)?.processedAt || null,
    lastSourceChangeAt: state.imports.findLast(item => item.change === 'source-changed')?.processedAt || null,
  };
}

/** Exact before/after files. Duplicate names remain separate; positional source IDs are not lineage. */
export function compareCareerSources(before, after) {
  const remaining = new Set(after.map((_source, index) => index));
  const changes = [];
  const unmatched = [];
  before.forEach((source, index) => {
    const match = [...remaining].find(next => after[next].name === source.name && after[next].contentHash === source.contentHash);
    if (match === undefined) unmatched.push(index);
    else {
      remaining.delete(match);
      if (index !== match) changes.push({ op: 'reordered', beforeIndex: index, afterIndex: match, before: source, after: after[match] });
    }
  });
  for (const index of unmatched) {
    const source = before[index];
    const names = [...remaining].filter(next => after[next].name === source.name);
    const uniqueName = before.filter(item => item.name === source.name).length === 1 && after.filter(item => item.name === source.name).length === 1;
    const hashes = [...remaining].filter(next => after[next].contentHash === source.contentHash);
    const uniqueHash = before.filter(item => item.contentHash === source.contentHash).length === 1 && after.filter(item => item.contentHash === source.contentHash).length === 1;
    const match = uniqueName && names.length === 1 ? names[0] : uniqueHash && hashes.length === 1 ? hashes[0] : undefined;
    if (match === undefined) changes.push({ op: 'removed', beforeIndex: index, before: source, after: null });
    else {
      remaining.delete(match);
      changes.push({ op: source.contentHash === after[match].contentHash ? 'renamed' : 'modified', beforeIndex: index, afterIndex: match, before: source, after: after[match] });
    }
  }
  for (const index of remaining) changes.push({ op: 'added', afterIndex: index, before: null, after: after[index] });
  return changes;
}

/** Read-only session evidence. No import is automatically considered a fix or an active module profile. */
export async function careerImportReview({ root, careerSnapshotId, careerSourceFrozenAt, generatedAt, savedAt }, { loadSnapshot = readPinnedCareerSnapshot } = {}) {
  const state = await readCareerImportHistory(root);
  const warnings = ['Imports record successful processing, not module adoption or proof that an application edit is resolved.'];
  const frozenAt = typeof careerSourceFrozenAt === 'string' && Number.isFinite(Date.parse(careerSourceFrozenAt))
    && Date.parse(careerSourceFrozenAt) <= Date.parse(generatedAt) ? careerSourceFrozenAt : null;
  const since = frozenAt || generatedAt;
  const report = { careerSnapshotId: careerSnapshotId || null, careerSourceFrozenAt: frozenAt, generatedAt, savedAt, historyStartedAt: state.startedAt, warnings, baseline: null, laterImports: [] };
  if (!HASH.test(careerSnapshotId || '')) {
    warnings.push('This legacy bundle has no exact career snapshot provenance. Its source-related edits remain uncertain.');
    return report;
  }
  if (!frozenAt) warnings.push('The source-freeze time is unavailable. Imports during generation before bundle logging may be absent from this report.');
  if (!state.startedAt || Date.parse(since) < Date.parse(state.startedAt)) warnings.push('Import history does not cover the time this bundle source was frozen.');
  const loaded = new Map();
  const load = async id => {
    if (!loaded.has(id)) {
      try { loaded.set(id, await loadSnapshot(careerSnapshotStorageRoot(root), id)); }
      catch { loaded.set(id, null); }
      if (!loaded.get(id)) warnings.push(`Snapshot ${id} is missing or invalid; source evidence is incomplete.`);
    }
    return loaded.get(id);
  };
  const baseline = await load(careerSnapshotId);
  if (!baseline) return report;
  const files = snapshot => snapshot.sources.map(({ name, contentHash, text }) => ({ name, contentHash, text }));
  report.baseline = { snapshotId: careerSnapshotId, sources: files(baseline) };
  const originScopes = new Set(state.imports.filter(item => item.snapshotId === careerSnapshotId && Date.parse(item.processedAt) <= Date.parse(since) && item.scopeId).map(item => item.scopeId));
  for (const event of state.imports) {
    if (!(Date.parse(event.processedAt) > Date.parse(since))) continue;
    const snapshot = await load(event.snapshotId);
    report.laterImports.push({
      ...event,
      relationship: originScopes.has(event.scopeId) ? 'scope-also-processed-original-snapshot' : 'applicability-unknown',
      afterBundleLogged: Date.parse(event.processedAt) > Date.parse(generatedAt),
      afterLatestSave: Date.parse(event.processedAt) > Date.parse(savedAt),
      sourceChanges: snapshot ? compareCareerSources(files(baseline), files(snapshot)) : null,
    });
  }
  return report;
}

export { fileFor as careerImportLogFile };
