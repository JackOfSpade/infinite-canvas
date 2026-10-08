/**
 * Names and validates the durable Job Search analysis artifacts.
 *
 * A directory can contain several canvases.  Snapshot files must therefore be
 * keyed by the full resolved canvas path rather than a shared friendly filename
 * (or merely a basename, which still collides for differently located files).
 */
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { rawCanvasRecoveryPath, resolveCanvasRecoveryPath, withCanvasRecoveryRebind } from './canvasRecoveryPaths.js';

const JOB_ANALYSIS_JSON = 'job-search-last-scrape.json';
const JOB_ANALYSIS_LAST_SUCCESS_JSON = 'job-search-last-successful-scrape.json';
// Keep the historical last-success filename as generation 1.  That lets an
// upgraded build read an existing recovery record without migration while the
// numbered names add two older, owner-scoped recovery points.
const JOB_ANALYSIS_SUCCESSFUL_GENERATIONS = 3;
const JOB_ANALYSIS_PROMPT = 'job-search-scoring-AI-prompt.txt';
// A populated Job Search snapshot/checkpoint can legitimately contain a large
// recovered candidate pool. The production report captured a 59.5 MiB record,
// so a 32 MiB rebind ceiling made Save As/rename reject valid recovery data.
// Keep a finite per-artifact cap (not an unbounded directory read) while
// allowing that known real-world payload with a little operational headroom.
const MAX_REBIND_ARTIFACT_BYTES = 64 * 1024 * 1024;

async function fsyncDirectory(directory) {
  const handle = await fs.promises.open(directory, 'r').catch(() => null);
  if (!handle) return;
  try { await handle.sync(); } finally { await handle.close(); }
}

export function resolveJobAnalysisCanvasPath(canvasFilePath, { followRebindAliases = true } = {}) {
  return followRebindAliases ? resolveCanvasRecoveryPath(canvasFilePath) : rawCanvasRecoveryPath(canvasFilePath);
}

function savedCanvasPath(canvasFilePath) {
  return resolveJobAnalysisCanvasPath(canvasFilePath);
}

/** A non-sensitive, deterministic namespace for one exact saved canvas. */
export function jobAnalysisCanvasNamespace(canvasFilePath) {
  const canvasPath = savedCanvasPath(canvasFilePath);
  if (!canvasPath) return null;
  // 128 bits leaves a practically unreachable collision probability while not
  // placing a user-controlled filename/path in an artifact name or report.
  return crypto.createHash('sha256').update(canvasPath).digest('hex').slice(0, 32);
}

function normalizedOwnerId(ownerId) {
  return typeof ownerId === 'string' && ownerId.trim() ? ownerId.trim() : null;
}

// Unsaved canvases have no durable path to namespace their private recovery
// files. The main process therefore supplies a process/session-local opaque
// scope for renderer-originated work. Keep this deliberately conservative: an
// absent/invalid value selects the historical fallback bundle for old/internal
// callers, while a valid scope may contain only fixed-format opaque tokens.
function normalizedUnsavedScope(scope) {
  return typeof scope === 'string' && /^[A-Za-z0-9_-]{16,200}$/.test(scope)
    ? scope
    : null;
}

/**
 * A non-sensitive, deterministic namespace for one Job Search hub within a
 * canvas. `null` deliberately means "use the historical canvas bundle" so
 * callers that have not yet been upgraded remain fully backward compatible.
 */
export function jobAnalysisOwnerNamespace(canvasFilePath, ownerId, unsavedScope = null) {
  const owner = normalizedOwnerId(ownerId);
  if (!owner) return null;
  const canvasPath = savedCanvasPath(canvasFilePath);
  // Include an explicit unsaved marker: an unsaved hub whose id happens to be
  // reused must not name the same file as a saved canvas with that id. A
  // renderer-session scope further separates two simultaneously open unsaved
  // canvases that happen to retain the same cloned node ID.
  const scope = canvasPath || `\u0000unsaved-canvas\u0000${normalizedUnsavedScope(unsavedScope) || 'legacy'}`;
  return crypto.createHash('sha256').update(`${scope}\u0000${owner}`).digest('hex').slice(0, 32);
}

/**
 * Resolve the current artifact bundle. `fallbackDir` is the private app-data
 * directory for unsaved canvases. Passing a Job Search hub id opts into the
 * current per-canvas, per-owner namespace. Omitting it preserves the previous
 * per-canvas path exactly, which is important while callers are migrated.
 */
export function getJobAnalysisPaths(canvasFilePath, fallbackDir, ownerId = null, unsavedScope = null) {
  const canvasPath = savedCanvasPath(canvasFilePath);
  const dir = canvasPath ? path.dirname(canvasPath) : fallbackDir;
  const namespace = jobAnalysisCanvasNamespace(canvasPath);
  const ownerNamespace = jobAnalysisOwnerNamespace(canvasPath, ownerId, unsavedScope);
  const requestScopedUnsaved = !canvasPath && !!normalizedUnsavedScope(unsavedScope);
  const canvasPrefix = namespace ? `job-search-${namespace}` : 'job-search';
  const unsavedScopeHash = !namespace && normalizedUnsavedScope(unsavedScope)
    ? crypto.createHash('sha256').update(normalizedUnsavedScope(unsavedScope)).digest('hex').slice(0, 16)
    : null;
  const primaryPrefix = ownerNamespace
    ? (namespace
      ? `${canvasPrefix}-${ownerNamespace}`
      : `job-search-unsaved-${unsavedScopeHash ? `${unsavedScopeHash}-` : ''}${ownerNamespace}`)
    : canvasPrefix;
  const name = (suffix) => `${primaryPrefix}-${suffix}`;
  const legacyCanvasName = (suffix, legacyName) => namespace
    ? `${canvasPrefix}-${suffix}`
    : legacyName;
  const lastSuccessJsonPath = path.join(dir, name('last-successful-scrape.json'));
  const lastSuccessJsonPaths = Array.from({ length: JOB_ANALYSIS_SUCCESSFUL_GENERATIONS }, (_, index) => (
    index === 0
      ? lastSuccessJsonPath
      : path.join(dir, name(`last-successful-scrape-${index + 1}.json`))
  ));
  return {
    dir,
    jsonPath: path.join(dir, name('last-scrape.json')),
    // `lastSuccessJsonPath` remains the newest successful generation for
    // compatibility with existing callers. New code should inspect this
    // ordered array (newest to oldest) when recovery may safely fall back.
    lastSuccessJsonPath,
    lastSuccessJsonPaths,
    promptPath: path.join(dir, name('scoring-AI-prompt.txt')),
    operationAuthorityPath: path.join(dir, name('operation-authority.json')),
    // These are the prior (canvas-only) hashed bundle. They are legacy only
    // when an owner namespace was requested; otherwise they are this call's
    // primary paths and must not be inspected or deleted twice.
    // An unsaved sender-scoped bundle must never fall back to the historical
    // process-global files: cloned hub IDs in two windows could otherwise read
    // one another's old recovery content. Contextless internal/test callers
    // retain the compatibility fallback during migration.
    legacyCanvasJsonPath: ownerNamespace && !requestScopedUnsaved ? path.join(dir, legacyCanvasName('last-scrape.json', JOB_ANALYSIS_JSON)) : null,
    legacyCanvasLastSuccessJsonPath: ownerNamespace && !requestScopedUnsaved ? path.join(dir, legacyCanvasName('last-successful-scrape.json', JOB_ANALYSIS_LAST_SUCCESS_JSON)) : null,
    legacyCanvasPromptPath: ownerNamespace && !requestScopedUnsaved ? path.join(dir, legacyCanvasName('scoring-AI-prompt.txt', JOB_ANALYSIS_PROMPT)) : null,
    // Pre-namespace files may be read only after their JSON identifies this
    // exact canvas. New writes never touch them, so one canvas cannot clobber
    // another canvas's legacy recovery record.
    legacyJsonPath: namespace ? path.join(dir, JOB_ANALYSIS_JSON) : null,
    legacyLastSuccessJsonPath: namespace ? path.join(dir, JOB_ANALYSIS_LAST_SUCCESS_JSON) : null,
    legacyPromptPath: namespace ? path.join(dir, JOB_ANALYSIS_PROMPT) : null,
    canvasPath,
    namespace,
    ownerId: normalizedOwnerId(ownerId),
    ownerNamespace,
  };
}

/** Prefix shared by checkpoint writers and discovery, including unsaved scopes. */
export function getJobDescriptionRecoveryCheckpointPrefix(canvasFilePath, fallbackDir, unsavedScope = null) {
  const paths = getJobAnalysisPaths(canvasFilePath, fallbackDir, null, unsavedScope);
  const scopeHash = !paths.namespace && normalizedUnsavedScope(unsavedScope)
    ? crypto.createHash('sha256').update(normalizedUnsavedScope(unsavedScope)).digest('hex').slice(0, 16)
    : null;
  const bundlePrefix = paths.namespace
    ? `job-search-${paths.namespace}`
    : (scopeHash ? `job-search-unsaved-${scopeHash}` : 'job-search');
  return `${bundlePrefix}-description-recovery-`;
}

/** A private per-canvas, per-run recovery checkpoint for post-gather Solves. */
export function getJobDescriptionRecoveryCheckpointPath(canvasFilePath, runId, fallbackDir, unsavedScope = null) {
  const normalizedRunId = typeof runId === 'string' ? runId.trim() : '';
  if (!normalizedRunId) return null;
  const paths = getJobAnalysisPaths(canvasFilePath, fallbackDir, null, unsavedScope);
  const runHash = crypto.createHash('sha256').update(normalizedRunId).digest('hex').slice(0, 24);
  return path.join(paths.dir, `${getJobDescriptionRecoveryCheckpointPrefix(canvasFilePath, fallbackDir, unsavedScope)}${runHash}.json`);
}

/** True only when a legacy snapshot explicitly belongs to this saved canvas. */
export function snapshotOwnedByCanvas(snapshot, canvasFilePath) {
  const expected = savedCanvasPath(canvasFilePath);
  if (!expected || !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  const recorded = snapshot.canvasFilePath || snapshot.snapshotContext?.canvasFilePath || null;
  return typeof recorded === 'string' && recorded.trim() && savedCanvasPath(recorded) === expected;
}

function rewriteCanvasOwnership(value, oldCanvasPath, newCanvasPath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = { ...value };
  if (typeof out.canvasFilePath === 'string' && resolveJobAnalysisCanvasPath(out.canvasFilePath, { followRebindAliases: false }) === oldCanvasPath) {
    out.canvasFilePath = newCanvasPath;
  }
  if (out.snapshotContext && typeof out.snapshotContext === 'object' && !Array.isArray(out.snapshotContext)) {
    out.snapshotContext = { ...out.snapshotContext };
    if (typeof out.snapshotContext.canvasFilePath === 'string'
        && resolveJobAnalysisCanvasPath(out.snapshotContext.canvasFilePath, { followRebindAliases: false }) === oldCanvasPath) {
      out.snapshotContext.canvasFilePath = newCanvasPath;
    }
  }
  return out;
}

function recoveryArtifactOwner(value) {
  const candidates = [
    value?.hubId,
    value?.sourceHubId,
    value?.nodeId,
    value?.snapshotContext?.sourceHubId,
    value?.snapshotContext?.nodeId,
  ].filter(candidate => typeof candidate === 'string' && candidate.trim());
  const owners = [...new Set(candidates.map(candidate => candidate.trim()))];
  return owners.length === 1 ? owners[0] : null;
}

function rebindArtifactName(name, oldPrefix, newNamespace, oldCanvasPath, newCanvasPath, parsed, ownersByNamespace) {
  let suffix = name.slice(oldPrefix.length);
  const match = suffix.match(/^([a-f0-9]{32})-(.+)$/);
  if (match) {
    const owner = recoveryArtifactOwner(parsed) || ownersByNamespace.get(match[1]);
    const oldOwnerNamespace = owner ? jobAnalysisOwnerNamespace(oldCanvasPath, owner) : null;
    const newOwnerNamespace = owner ? jobAnalysisOwnerNamespace(newCanvasPath, owner) : null;
    // A 32-byte-looking prefix is not enough to establish owner identity. The
    // verified envelope must bind it to this exact old canvas + hub.
    if (!owner || !oldOwnerNamespace || !newOwnerNamespace || oldOwnerNamespace !== match[1]) {
      throw new Error('artifact-owner-namespace-mismatch');
    }
    suffix = `${newOwnerNamespace}-${match[2]}`;
  }
  return `job-search-${newNamespace}-${suffix}`;
}

function rebindPublicationDigests(authority, destinationBytes, newPrefix) {
  if (!authority || typeof authority !== 'object') return authority;
  const hubId = recoveryArtifactOwner(authority);
  if (!hubId) throw new Error('authority-owner-missing');
  const ownerNamespace = jobAnalysisOwnerNamespace(authority.canvasFilePath, hubId);
  if (!ownerNamespace) throw new Error('authority-owner-namespace-missing');
  const nameForSlot = slot => {
    if (slot === 'current') return `${newPrefix}-${ownerNamespace}-last-scrape.json`;
    const success = /^success:([1-3])$/.exec(slot);
    if (success) return `${newPrefix}-${ownerNamespace}-last-successful-scrape${success[1] === '1' ? '' : `-${success[1]}`}.json`;
    const checkpoint = /^checkpoint:([a-f0-9]{24})$/.exec(slot);
    return checkpoint ? `${newPrefix}-description-recovery-${checkpoint[1]}.json` : null;
  };
  for (const mapName of ['publications', 'pendingPublications']) {
    const map = authority[mapName];
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const [slot, publication] of Object.entries(map)) {
      const bytes = destinationBytes.get(nameForSlot(slot));
      if (!bytes || !publication || typeof publication !== 'object') continue;
      publication.digest = crypto.createHash('sha256').update(bytes).digest('hex');
    }
  }
  return authority;
}

/**
 * Move path-namespaced post-gather snapshots, prompts, and description-recovery
 * checkpoints to a newly adopted saved canvas. JSON envelopes are rewritten so
 * their exact ownership proof remains true after the path hash changes.
 */
export async function rebindJobAnalysisRecoveryOwners(oldCanvasFilePath, newCanvasFilePath, { alreadyExclusive = false } = {}) {
  // The production Save As coordinator already owns the cross-path gate, but
  // direct/support callers must receive the same drain guarantee. Do not
  // install an alias here: that belongs to the all-sidecar coordinator after
  // every recovery family has migrated successfully.
  if (!alreadyExclusive) {
    return withCanvasRecoveryRebind(oldCanvasFilePath, newCanvasFilePath,
      ({ oldPath, newPath }) => rebindJobAnalysisRecoveryOwners(oldPath, newPath, { alreadyExclusive: true }));
  }
  const oldCanvasPath = resolveJobAnalysisCanvasPath(oldCanvasFilePath, { followRebindAliases: false });
  const newCanvasPath = resolveJobAnalysisCanvasPath(newCanvasFilePath, { followRebindAliases: false });
  if (!oldCanvasPath || !newCanvasPath) return { success: false, reason: 'invalid-canvas-path' };
  if (oldCanvasPath === newCanvasPath) return { success: true, migratedCount: 0 };
  const oldNamespace = jobAnalysisCanvasNamespace(oldCanvasPath);
  const newNamespace = jobAnalysisCanvasNamespace(newCanvasPath);
  const oldDir = path.dirname(oldCanvasPath);
  const newDir = path.dirname(newCanvasPath);
  const oldPrefix = `job-search-${oldNamespace}-`;
  let names;
  try {
    names = (await fs.promises.readdir(oldDir, { withFileTypes: true }))
      // Discover lookalike links/directories too, then reject them explicitly
      // instead of silently treating an ambiguous recovery namespace as empty.
      .filter(entry => entry.name.startsWith(oldPrefix))
      .map(entry => entry.name);
  } catch (error) {
    return error?.code === 'ENOENT' ? { success: true, migratedCount: 0 } : { success: false, reason: 'scan-failed' };
  }
  const created = [];
  let sourceDeletionStarted = false;
  try {
    const parsedJson = new Map();
    const ownersByNamespace = new Map();
    for (const name of names.filter(name => name.endsWith('.json'))) {
      const source = path.join(oldDir, name);
      const stat = await fs.promises.lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_REBIND_ARTIFACT_BYTES) throw new Error('unsafe-artifact');
      const sourceBytes = await fs.promises.readFile(source);
      let parsed;
      try { parsed = JSON.parse(sourceBytes.toString('utf8')); } catch { throw new Error('malformed-artifact'); }
      const recorded = parsed?.canvasFilePath || parsed?.snapshotContext?.canvasFilePath;
      if (resolveJobAnalysisCanvasPath(recorded, { followRebindAliases: false }) !== oldCanvasPath) {
        throw new Error('artifact-ownership-mismatch');
      }
      parsedJson.set(name, parsed);
      const owner = recoveryArtifactOwner(parsed);
      if (owner) ownersByNamespace.set(jobAnalysisOwnerNamespace(oldCanvasPath, owner), owner);
    }
    // A crash can delete all old JSON envelopes before it reaches their prompt
    // companion. On replay the old owner hash is still in the prompt filename,
    // so recover its verified hub mapping from the already-created *new* JSON
    // envelopes. Never infer a hub from the filename alone.
    try {
      const destinationEntries = await fs.promises.readdir(newDir, { withFileTypes: true });
      const destinationPrefix = `job-search-${newNamespace}-`;
      for (const entry of destinationEntries) {
        if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.startsWith(destinationPrefix) || !entry.name.endsWith('.json')) continue;
        const candidate = path.join(newDir, entry.name);
        const stat = await fs.promises.lstat(candidate);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_REBIND_ARTIFACT_BYTES) continue;
        let parsed;
        try { parsed = JSON.parse(await fs.promises.readFile(candidate, 'utf8')); } catch { continue; }
        const recorded = parsed?.canvasFilePath || parsed?.snapshotContext?.canvasFilePath;
        if (resolveJobAnalysisCanvasPath(recorded, { followRebindAliases: false }) !== newCanvasPath) continue;
        const owner = recoveryArtifactOwner(parsed);
        if (owner) ownersByNamespace.set(jobAnalysisOwnerNamespace(oldCanvasPath, owner), owner);
      }
    } catch { /* absent/unreadable destination directory cannot prove an owner */ }
    // Build every rewritten JSON payload before creating any destination. The
    // authority record seals byte digests, so its maps must be recomputed from
    // the exact new bytes after canvas ownership and owner namespaces change.
    const destinationNames = new Map();
    const destinationBytes = new Map();
    for (const [name, parsed] of parsedJson) {
      const destinationName = rebindArtifactName(name, oldPrefix, newNamespace, oldCanvasPath, newCanvasPath, parsed, ownersByNamespace);
      destinationNames.set(name, destinationName);
      if (!name.endsWith('operation-authority.json')) {
        destinationBytes.set(destinationName, Buffer.from(`${JSON.stringify(rewriteCanvasOwnership(parsed, oldCanvasPath, newCanvasPath), null, 2)}\n`, 'utf8'));
      }
    }
    for (const [name, parsed] of parsedJson) {
      if (!name.endsWith('operation-authority.json')) continue;
      const rewritten = rewriteCanvasOwnership(parsed, oldCanvasPath, newCanvasPath);
      rebindPublicationDigests(rewritten, destinationBytes, `job-search-${newNamespace}`);
      destinationBytes.set(destinationNames.get(name), Buffer.from(`${JSON.stringify(rewritten, null, 2)}\n`, 'utf8'));
    }
    for (const name of names) {
      const suffix = name.slice(oldPrefix.length);
      if (!/^(?:(?:[a-f0-9]{32}-)?(?:last-scrape\.json|last-successful-scrape(?:-[23])?\.json|scoring-AI-prompt\.txt|operation-authority\.json)|description-recovery-[a-f0-9]{24}\.json)$/.test(suffix)) {
        throw new Error('unrecognized-artifact');
      }
      const source = path.join(oldDir, name);
      const destination = path.join(newDir, destinationNames.get(name) || rebindArtifactName(name, oldPrefix, newNamespace, oldCanvasPath, newCanvasPath, parsedJson.get(name), ownersByNamespace));
      const stat = await fs.promises.lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_REBIND_ARTIFACT_BYTES) throw new Error('unsafe-artifact');
      const sourceBytes = await fs.promises.readFile(source);
      let bytes = sourceBytes;
      if (name.endsWith('.json')) {
        bytes = destinationBytes.get(path.basename(destination));
        if (!bytes) throw new Error('malformed-artifact');
      } else if (name.endsWith('.txt')) {
        // Prompt content carries no owner field. Migrate it only beside a
        // verified snapshot from the same (canvas or canvas+hub) namespace.
        const promptStem = name.slice(0, -'-scoring-AI-prompt.txt'.length);
        let hasOwnerSnapshot = [...parsedJson.keys()].some(jsonName => (
          jsonName === `${promptStem}-last-scrape.json`
          || jsonName === `${promptStem}-last-successful-scrape.json`
        ));
        if (!hasOwnerSnapshot) {
          // Idempotent replay after a crash between old JSON and old prompt
          // deletion: accept the surviving prompt only when the exact rewritten
          // destination snapshot proves the owner and no content is guessed.
          // `destination` is already rekeyed to the new canvas + owner
          // namespace. Reconstructing from the old prompt suffix would look
          // beside an owner hash no new-path reader can ever discover.
          const destinationStem = path.basename(destination, '-scoring-AI-prompt.txt');
          for (const suffix of ['last-scrape.json', 'last-successful-scrape.json']) {
            const destinationSnapshot = path.join(newDir, `${destinationStem}-${suffix}`);
            try {
              const destinationStat = await fs.promises.lstat(destinationSnapshot);
              if (!destinationStat.isFile() || destinationStat.isSymbolicLink() || destinationStat.size > MAX_REBIND_ARTIFACT_BYTES) continue;
              const destinationParsed = JSON.parse(await fs.promises.readFile(destinationSnapshot, 'utf8'));
              const recorded = destinationParsed?.canvasFilePath || destinationParsed?.snapshotContext?.canvasFilePath;
              if (resolveJobAnalysisCanvasPath(recorded, { followRebindAliases: false }) === newCanvasPath) {
                hasOwnerSnapshot = true;
                break;
              }
            } catch { /* this companion is absent or not a verified JSON envelope */ }
          }
        }
        if (!hasOwnerSnapshot) throw new Error('orphaned-prompt-artifact');
      }
      try {
        const handle = await fs.promises.open(destination, 'wx', stat.mode & 0o777);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await fsyncDirectory(newDir);
        created.push(destination);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existingStat = await fs.promises.lstat(destination);
        if (!existingStat.isFile() || existingStat.isSymbolicLink() || existingStat.size > MAX_REBIND_ARTIFACT_BYTES) throw new Error('unsafe-destination');
        const existing = await fs.promises.readFile(destination);
        if (!existing.equals(bytes)) throw new Error('destination-artifact-conflict');
      }
    }
    for (const name of names) {
      sourceDeletionStarted = true;
      await fs.promises.unlink(path.join(oldDir, name));
    }
    await fsyncDirectory(oldDir);
    return { success: true, migratedCount: names.length };
  } catch (error) {
    // After any source unlink, a newly written destination may be the only
    // exact recovery copy. Keep it for journal replay; only pre-delete
    // failures may safely remove files created by this attempt.
    if (!sourceDeletionStarted) await Promise.all(created.map(filePath => fs.promises.unlink(filePath).catch(() => {})));
    return { success: false, reason: error?.message === 'destination-artifact-conflict' ? 'destination-conflict' : 'migration-failed' };
  }
}
