/**
 * Names and validates the durable Job Search analysis artifacts.
 *
 * A directory can contain several canvases.  Snapshot files must therefore be
 * keyed by the full resolved canvas path rather than a shared friendly filename
 * (or merely a basename, which still collides for differently located files).
 */
import crypto from 'crypto';
import path from 'path';

export const JOB_ANALYSIS_JSON = 'job-search-last-scrape.json';
export const JOB_ANALYSIS_LAST_SUCCESS_JSON = 'job-search-last-successful-scrape.json';
export const JOB_ANALYSIS_PROMPT = 'job-search-scoring-AI-prompt.txt';

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

/**
 * Resolve the current artifact bundle. `fallbackDir` is the private app-data
 * directory for unsaved canvases; saved canvases always use a separate,
 * per-canvas namespace in their own directory.
 */
export function getJobAnalysisPaths(canvasFilePath, fallbackDir) {
  const canvasPath = savedCanvasPath(canvasFilePath);
  const dir = canvasPath ? path.dirname(canvasPath) : fallbackDir;
  const namespace = jobAnalysisCanvasNamespace(canvasPath);
  const name = (suffix, legacyName) => namespace
    ? `job-search-${namespace}-${suffix}`
    : legacyName;
  return {
    dir,
    jsonPath: path.join(dir, name('last-scrape.json', JOB_ANALYSIS_JSON)),
    lastSuccessJsonPath: path.join(dir, name('last-successful-scrape.json', JOB_ANALYSIS_LAST_SUCCESS_JSON)),
    promptPath: path.join(dir, name('scoring-AI-prompt.txt', JOB_ANALYSIS_PROMPT)),
    // Pre-namespace files may be read only after their JSON identifies this
    // exact canvas. New writes never touch them, so one canvas cannot clobber
    // another canvas's legacy recovery record.
    legacyJsonPath: namespace ? path.join(dir, JOB_ANALYSIS_JSON) : null,
    legacyLastSuccessJsonPath: namespace ? path.join(dir, JOB_ANALYSIS_LAST_SUCCESS_JSON) : null,
    legacyPromptPath: namespace ? path.join(dir, JOB_ANALYSIS_PROMPT) : null,
    canvasPath,
    namespace,
  };
}

/** True only when a legacy snapshot explicitly belongs to this saved canvas. */
export function snapshotOwnedByCanvas(snapshot, canvasFilePath) {
  const expected = savedCanvasPath(canvasFilePath);
  if (!expected || !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  const recorded = snapshot.canvasFilePath || snapshot.snapshotContext?.canvasFilePath || null;
  return typeof recorded === 'string' && recorded.trim() && path.resolve(recorded) === expected;
}
