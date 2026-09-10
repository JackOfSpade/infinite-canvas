/**
 * Names and validates the durable Job Search analysis artifacts.
 *
 * A directory can contain several canvases.  Snapshot files must therefore be
 * keyed by the full resolved canvas path rather than a shared friendly filename
 * (or merely a basename, which still collides for differently located files).
 */
import crypto from 'crypto';
import path from 'path';

const JOB_ANALYSIS_JSON = 'job-search-last-scrape.json';
const JOB_ANALYSIS_LAST_SUCCESS_JSON = 'job-search-last-successful-scrape.json';
const JOB_ANALYSIS_PROMPT = 'job-search-scoring-AI-prompt.txt';

function savedCanvasPath(canvasFilePath) {
  return typeof canvasFilePath === 'string' && canvasFilePath.trim()
    ? path.resolve(canvasFilePath)
    : null;
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
  return {
    dir,
    jsonPath: path.join(dir, name('last-scrape.json')),
    lastSuccessJsonPath: path.join(dir, name('last-successful-scrape.json')),
    promptPath: path.join(dir, name('scoring-AI-prompt.txt')),
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
  return typeof recorded === 'string' && recorded.trim() && path.resolve(recorded) === expected;
}
