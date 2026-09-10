/**
 * Job-search run staging + manifest — crash/quit recovery for long scrapes.
 *
 * A job search can run for minutes (browser sources scrape sequentially, deep
 * paginating). Today everything lives in memory until the very end, so a crash /
 * quit / power-loss mid-run loses the whole scrape. This module persists two
 * sidecars next to the canvas JSON, surviving an app restart:
 *
 *   <canvas>.jobs-staging.<hub>.jsonl   append-only, ONE job per line, flushed per page
 *                                  as each source/query/page completes. Holds the
 *                                  RAW gathered jobs (pre dedup/score) so a resume
 *                                  recovers them without re-scraping finished pages.
 *
 *   <canvas>.jobs-run.<hub>.json  the run manifest / ledger — the "did it finish?"
 *                                  signal + where each (source,query) got to:
 *     {
 *       version, runId, startedAt, lastUpdated,
 *       stage: 'searching' | 'gathered',
 *       inputs: { queries, profileFingerprint, targetRole, jobPreferences,
 *                 jobPreferencePlan, canonicalLocation, maxAgeDays, nodeId },
 *       sources: { [sourceId]: { status: 'pending'|'done'|'blocked',
 *                                queries: { [query]: { lastPage } } } }
 *     }
 *
 * `stage` values actually written: 'searching' (run start / resume re-entry)
 * and 'gathered' (search phase finished; the renderer-driven scoring/bucketing
 * that follows can crash and still resume from the staged jobs). There is NO
 * 'done' stage — a clean finish is signaled by DELETING both sidecars
 * (complete-job-run), so any manifest on disk means an unfinished run.
 *
 * On the next launch, an incomplete + recent manifest is what the renderer
 * detects to offer "Resume or start fresh?".
 *
 * Atomicity: the manifest is written tmp→rename (never half-written). The staging
 * file is append-only — a torn final line after a hard crash is just one
 * unparseable JSONL row, which the reader skips. No heavy deps (fs/path/logger
 * only) so it is unit-testable in the plain-node test runner.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from '../logger.js';

const MANIFEST_VERSION = 2;
// Unlike the manifest/staging pair, this compact receipt intentionally survives
// a clean finish. It answers "did the prior-process run complete?" without
// retaining listings, search queries, career data, URLs, or warning evidence.
// Version 3 adds the redacted, run-scoped post-search recovery delta alongside
// scoring and safe source-cap coverage. Readers remain compatible because every
// added field is optional.
const JOB_RUN_RECEIPT_VERSION = 3;
// A manifest older than this is "stale" — not auto-offered for resume (the user
// likely abandoned it). 24h; the renderer can still surface a manual choice.
export const RESUMABLE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Sidecar paths for a canvas file, or null when the canvas was never saved. */
function normalizeNodeId(nodeIdOrOptions) {
  const nodeId = typeof nodeIdOrOptions === 'object' && nodeIdOrOptions !== null
    ? nodeIdOrOptions.nodeId
    : nodeIdOrOptions;
  return typeof nodeId === 'string' && nodeId.trim() ? nodeId.trim() : null;
}

function pathHash(value, length = 24) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, length);
}

function resolvedCanvasPath(canvasFilePath) {
  if (!canvasFilePath || typeof canvasFilePath !== 'string') return null;
  try { return path.resolve(canvasFilePath); } catch { return null; }
}

// A fixed-size full-path canvas hash prevents `project` and `project.json`
// from sharing sidecars. A fixed owner hash also makes imported malformed IDs
// unable to exceed filesystem NAME_MAX. The manifest remains the authority
// for the human-readable owner id.
export function jobRunPathScopeForCanvas(canvasFilePath, nodeIdOrOptions = null) {
  const canvasPath = resolvedCanvasPath(canvasFilePath);
  if (!canvasPath) return null;
  const nodeId = normalizeNodeId(nodeIdOrOptions);
  return {
    canvasPath,
    dir: path.dirname(canvasPath),
    base: path.basename(canvasPath).replace(/\.json$/i, ''),
    canvasHash: pathHash(canvasPath),
    nodeId,
    ownerHash: nodeId ? pathHash(nodeId) : null,
  };
}

// Baseline singleton filenames are deliberately retained for migration. The
// prior node-scoped generation used an escaped owner ID and is readable only
// after exact owner verification and a basename-collision check.
function runFilesForCanvas(canvasFilePath, nodeIdOrOptions = null) {
  const scope = jobRunPathScopeForCanvas(canvasFilePath, nodeIdOrOptions);
  if (!scope) return null;
  const { dir, base, canvasHash, nodeId, ownerHash } = scope;
  const scoped = nodeId ? `.${canvasHash}.${ownerHash}` : '';
  return {
    staging:  path.join(dir, `${base}.jobs-staging${scoped}.jsonl`),
    manifest: path.join(dir, `${base}.jobs-run${scoped}.json`),
    nodeId,
    legacy: !nodeId,
  };
}

function priorScopedRunFilesForCanvas(canvasFilePath, nodeIdOrOptions = null) {
  const scope = jobRunPathScopeForCanvas(canvasFilePath, nodeIdOrOptions);
  if (!scope?.nodeId) return null;
  const escaped = encodeURIComponent(scope.nodeId);
  return {
    staging: path.join(scope.dir, `${scope.base}.jobs-staging.${escaped}.jsonl`),
    manifest: path.join(scope.dir, `${scope.base}.jobs-run.${escaped}.json`),
    nodeId: scope.nodeId,
    legacy: false,
    priorScoped: true,
  };
}

/** Durable, redacted terminal receipt path for a saved canvas. */
export function lastRunReceiptPathForCanvas(canvasFilePath, nodeIdOrOptions = null) {
  const scope = jobRunPathScopeForCanvas(canvasFilePath, nodeIdOrOptions);
  if (!scope) return null;
  return path.join(scope.dir, `${scope.base}.jobs-last-run${scope.nodeId ? `.${scope.canvasHash}.${scope.ownerHash}` : ''}.json`);
}

function priorScopedLastRunReceiptPathForCanvas(canvasFilePath, nodeIdOrOptions = null) {
  const scope = jobRunPathScopeForCanvas(canvasFilePath, nodeIdOrOptions);
  if (!scope?.nodeId) return null;
  return path.join(scope.dir, `${scope.base}.jobs-last-run.${encodeURIComponent(scope.nodeId)}.json`);
}

// A legacy basename sidecar carries no full canvas identity. It is safe only
// when the sibling spelling that shares this basename does not exist.
async function hasBasenameCanvasCollision(canvasFilePath) {
  const scope = jobRunPathScopeForCanvas(canvasFilePath);
  if (!scope) return true;
  for (const candidate of [path.join(scope.dir, scope.base), path.join(scope.dir, `${scope.base}.json`)]) {
    if (candidate === scope.canvasPath) continue;
    const stat = await fs.promises.stat(candidate).catch(() => null);
    if (stat?.isFile()) return true;
  }
  return false;
}

let _tmpSeq = 0;
async function atomicWriteJson(filePath, obj) {
  // Unique tmp name PER WRITE: concurrent writers must not share a tmp path, or
  // the first rename() moves it out from under the others → ENOENT (and a lost
  // write). A bare counter is enough (the test runner forbids Date.now/random);
  // the per-path mutex below already serializes manifest writers, so this is
  // defense-in-depth for any caller that bypasses the lock.
  const tmp = `${filePath}.${process.pid}.${_tmpSeq++}.tmp`;
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(tmp, filePath);
  } finally {
    // A failed write/rename must not accumulate sidecars forever. If rename
    // succeeded the temporary no longer exists, so ENOENT is expected here.
    await fs.promises.unlink(tmp).catch(() => {});
  }
}

// Per-manifest-path FIFO mutex. Every mutator is a read-modify-write of the WHOLE
// manifest; without serialization, concurrent callers (e.g. the per-source
// markSourceStatus loop firing one write per source at once) all read the same
// stale manifest and clobber each other's updates — and a late stale write can
// even revert `stage` back to 'searching'. Keyed by path so different canvases
// never block one another. Same dependency-free pattern as sharedProfileLock.
const _manifestTails = new Map();
function withManifestLock(filePath, fn) {
  const prev = _manifestTails.get(filePath) || Promise.resolve();
  const result = prev.then(fn, fn); // run regardless of the prior op's outcome
  const tail = result.then(() => {}, () => {});
  _manifestTails.set(filePath, tail);
  return result.finally(() => {
    // Canvas paths are unbounded over a long app session. Remove an idle key
    // without disturbing a newer operation that queued behind this one.
    if (_manifestTails.get(filePath) === tail) _manifestTails.delete(filePath);
  });
}

// Receipt writes are normally made from the manifest-locked completion
// transaction below. Keep an independent path mutex for report/test callers
// too, so an out-of-band read/update cannot tear a JSON receipt.
const _receiptTails = new Map();
function withReceiptLock(filePath, fn) {
  const prev = _receiptTails.get(filePath) || Promise.resolve();
  const result = prev.then(fn, fn);
  const tail = result.then(() => {}, () => {});
  _receiptTails.set(filePath, tail);
  return result.finally(() => {
    if (_receiptTails.get(filePath) === tail) _receiptTails.delete(filePath);
  });
}

function receiptNumber(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

function receiptTimestamp(value, fallback = null) {
  // Completion ordering is provenance, unlike display-only counters. Keep it
  // a real Date.now()-style number so strings/booleans cannot become a
  // plausible terminal instant before the board-clear report boundary sees it.
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    && Number.isFinite(new Date(value).getTime())
    ? value
    : fallback;
}

function receiptToken(value, max = 80) {
  const text = String(value ?? '').trim();
  // Source IDs, stop reasons, and warning codes are controlled identifiers.
  // Still restrict their character set here so no provider body/error text can
  // accidentally become durable report data through a future caller.
  return /^[a-zA-Z0-9_.:/-]+$/.test(text) ? text.slice(0, max) : null;
}

const RECEIPT_REVEAL_EXITS = new Set([
  'end-of-list',
  'plateau',
  'iteration-ceiling',
  'target-reached',
  'aborted',
]);
const RECEIPT_MAX_PAGES_WALKED = 100_000;

function sanitizeReceiptRevealOutcomes(values) {
  const outcomes = [];
  for (const value of (Array.isArray(values) ? values : []).slice(0, 20)) {
    const queryIndex = receiptNumber(value?.queryIndex, null);
    const queryTotal = receiptNumber(value?.queryTotal, null);
    const exit = receiptToken(value?.exit, 32);
    if (!(queryIndex > 0) || !(queryTotal > 0) || queryIndex > queryTotal || !RECEIPT_REVEAL_EXITS.has(exit)) continue;
    outcomes.push({
      queryIndex,
      queryTotal,
      exit,
      count: receiptNumber(value?.count),
      iterations: receiptNumber(value?.iterations),
    });
  }
  return outcomes;
}

function sanitizeReceiptSourceCap(cap) {
  if (!cap || typeof cap !== 'object' || Array.isArray(cap)) return null;
  // `source-internal` is a provider's own finite result ceiling (currently
  // LinkedIn's 150-offset walk), not a user-configured collection cap. It is
  // still safe aggregate-only provenance and the report explicitly refuses it
  // as configured-cap proof; dropping it here left a durable `result-ceiling`
  // stop with no number after restart.
  if (!['per-platform', 'jobs-per-platform', 'pages-per-platform', 'source-internal'].includes(cap.type)) return null;
  // A cap is completion evidence, not a display hint. Do not coerce truthy
  // values or fractions into a different integer cap (for example, 0.5 → 0),
  // since that could make a malformed receipt look like a user-configured
  // boundary in restart diagnostics.
  if (typeof cap.limit !== 'number' || !Number.isSafeInteger(cap.limit) || cap.limit <= 0) return null;
  return { type: cap.type, limit: cap.limit };
}

function sanitizeReceiptStopReason(value) {
  // Stop reasons are a slash-joined set assembled across API fan-out queries.
  // Bound individual controlled tokens, never the joined string: a blind
  // 80-character slice can cut `pages-per-platform` in half and turn a valid
  // configured-cap receipt into restart-time unproven coverage.
  const seen = new Set();
  const stops = [];
  for (const raw of String(value ?? '').split('/').slice(0, 24)) {
    const token = receiptToken(raw, 32);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    stops.push(token);
    if (stops.length >= 8) break;
  }
  return stops.join('/') || null;
}

function sanitizeReceiptSourceCaps(caps) {
  const seen = new Set();
  const safe = [];
  for (const cap of (Array.isArray(caps) ? caps : []).slice(0, 3)) {
    const normalized = sanitizeReceiptSourceCap(cap);
    if (!normalized) continue;
    const key = `${normalized.type}:${normalized.limit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    safe.push(normalized);
  }
  return safe;
}

function sanitizeReceiptSource(source = {}) {
  const warning = source.warning && typeof source.warning === 'object'
    ? {
        ...(receiptToken(source.warning.code) ? { code: receiptToken(source.warning.code) } : {}),
        ...(receiptToken(source.warning.severity, 24) ? { severity: receiptToken(source.warning.severity, 24) } : {}),
      }
    : null;
  const revealOutcomes = sanitizeReceiptRevealOutcomes(source.revealOutcomes);
  const cap = sanitizeReceiptSourceCap(source.cap);
  const caps = sanitizeReceiptSourceCaps(source.caps);
  const stopReason = sanitizeReceiptStopReason(source.stopReason);
  return {
    count: receiptNumber(source.count),
    providerGathered: receiptNumber(source.providerGathered),
    // This is a safe aggregate only: no titles, URLs, or provider text. It
    // explains why distinct candidate identities can exceed returned usable
    // rows after a detail page confirms that a posting is unavailable.
    ...(receiptNumber(source.unavailableDetailDropped) > 0
      ? { unavailableDetailDropped: receiptNumber(source.unavailableDetailDropped) }
      : {}),
    // A known Glassdoor nation-tier caveat. This is intentionally independent
    // from the source warning slot, so a benign scope disclosure cannot mask a
    // later block/error and remains available after process restart.
    ...(source.locationScopeUnenforced === true ? { locationScopeUnenforced: true } : {}),
    // Numbers only, same as every other field here: the provider's own corpus
    // size for this query plus the walk's own truncation flag. They are what
    // separates "this source has 44 postings" from "this source has 973 and we
    // read 44", which no other retained field can express.
    ...(source.providerTotal != null && source.providerTotal !== ''
      && Number.isFinite(Number(source.providerTotal)) && Number(source.providerTotal) >= 0
      ? { providerTotal: receiptNumber(source.providerTotal) }
      : {}),
    ...(source.truncated === true ? { truncated: true } : {}),
    ...(source.pagesWalked != null && source.pagesWalked !== ''
      && Number.isFinite(Number(source.pagesWalked)) && Number(source.pagesWalked) >= 0
      ? { pagesWalked: Math.min(RECEIPT_MAX_PAGES_WALKED, receiptNumber(source.pagesWalked)) }
      : {}),
    relevanceDropped: receiptNumber(source.relevanceDropped),
    ...(receiptNumber(source.sponsoredDropped) > 0 ? { sponsoredDropped: receiptNumber(source.sponsoredDropped) } : {}),
    ...(cap ? { cap } : {}),
    ...(caps.length > 0 ? { caps } : {}),
    ...(stopReason ? { stopReason } : {}),
    ...(warning && Object.keys(warning).length > 0 ? { warning } : {}),
    ...(revealOutcomes.length > 0 ? { revealOutcomes } : {}),
  };
}

function sanitizeReceiptScoring(scoring) {
  if (!scoring || typeof scoring !== 'object' || Array.isArray(scoring)) return null;
  const coreFields = ['input', 'selected', 'scored', 'placeholders', 'unscored', 'failedBatches'];
  if (!coreFields.every(key => (
    scoring[key] != null
    && scoring[key] !== ''
    && Number.isFinite(Number(scoring[key]))
    && Number(scoring[key]) >= 0
  ))) return null;
  // These are aggregate counters only. In particular, never retain a model
  // response, failure text, listing field, prompt, provider metadata, or URL.
  return {
    input: receiptNumber(scoring.input),
    selected: receiptNumber(scoring.selected),
    scored: receiptNumber(scoring.scored),
    placeholders: receiptNumber(scoring.placeholders),
    unscored: receiptNumber(scoring.unscored),
    failedBatches: receiptNumber(scoring.failedBatches),
    ...(Number.isFinite(Number(scoring.cappedForBudget)) && Number(scoring.cappedForBudget) >= 0
      ? { cappedForBudget: receiptNumber(scoring.cappedForBudget) }
      : {}),
    ...(Number.isFinite(Number(scoring.providerCalls)) && Number(scoring.providerCalls) >= 0
      ? { providerCalls: receiptNumber(scoring.providerCalls) }
      : {}),
  };
}

function sanitizeReceiptRecovery(recovery) {
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) return null;
  // Recovery is deliberately one signed integer. It reconciles the initial
  // funnel to the terminal scorer after restart, while excluding source IDs,
  // job rows, listing text, URLs, and renderer event detail.
  const mergeNet = recovery.mergeNet;
  if (typeof mergeNet !== 'number' || !Number.isSafeInteger(mergeNet)) return null;
  return { mergeNet };
}

/**
 * Whitelist the completion receipt shape. Keep this boundary defensive: this
 * artifact is read by support reports after restart, so it must never become a
 * backdoor for jobs, queries, profile data, URLs, or provider error bodies.
 */
export function sanitizeLastRunReceipt(receipt = {}) {
  // These opaque IDs correlate durable terminal receipts with a live hub and
  // board-clear provenance. Do not coerce `42`/`true` into plausible tokens:
  // a malformed sidecar must become invalid evidence, never a different run.
  const runId = typeof receipt.runId === 'string' ? receipt.runId.trim().slice(0, 180) : '';
  const nodeId = typeof receipt.nodeId === 'string' ? receipt.nodeId.trim().slice(0, 180) : '';
  const terminalStatus = ['completed', 'failed', 'aborted'].includes(receipt?.terminal?.status)
    ? receipt.terminal.status
    : 'completed';
  const terminalOutcome = ['zero', 'populated', 'collection-only', 'preference-filtered', 'incomplete', 'unknown'].includes(receipt?.terminal?.outcome)
    ? receipt.terminal.outcome
    : 'unknown';
  const completedAt = receiptTimestamp(receipt.completedAt);
  // The initial search funnel can legitimately be smaller than the terminal
  // score-ready set when a post-search source resume contributes additional
  // rows. Preserve the terminal count independently rather than implying that
  // the initial funnel's `kept` value is the completed scoring total.
  const scoreReadyCount = receiptNumber(receipt?.terminal?.scoreReadyCount, null);
  const sources = {};
  for (const [sourceId, source] of Object.entries(receipt.sources || {}).slice(0, 20)) {
    const safeId = receiptToken(sourceId, 60);
    if (safeId) sources[safeId] = sanitizeReceiptSource(source);
  }
  const funnel = receipt.funnel && typeof receipt.funnel === 'object' ? {
    raw: receiptNumber(receipt.funnel.raw),
    relevanceDropped: receiptNumber(receipt.funnel.relevanceDropped),
    deduped: receiptNumber(receipt.funnel.deduped),
    ageDropped: receiptNumber(receipt.funnel.ageDropped),
    roleDropped: receiptNumber(receipt.funnel.roleDropped),
    historyDropped: receiptNumber(receipt.funnel.historyDropped),
    descriptionEvidenceDropped: receiptNumber(receipt.funnel.descriptionEvidenceDropped),
    ...(receipt.funnel.finalDedupDropped != null ? { finalDedupDropped: receiptNumber(receipt.funnel.finalDedupDropped) } : {}),
    kept: receiptNumber(receipt.funnel.kept),
  } : null;
  const scoring = sanitizeReceiptScoring(receipt.scoring);
  const recovery = sanitizeReceiptRecovery(receipt.recovery);
  return {
    version: JOB_RUN_RECEIPT_VERSION,
    runId,
    nodeId,
    startedAt: receiptTimestamp(receipt.startedAt),
    completedAt,
    updatedAt: receiptTimestamp(receipt.updatedAt, completedAt),
    terminal: {
      status: terminalStatus,
      outcome: terminalOutcome,
      ...(scoreReadyCount != null ? { scoreReadyCount } : {}),
    },
    ...(funnel ? { funnel } : {}),
    ...(scoring ? { scoring } : {}),
    ...(recovery ? { recovery } : {}),
    sources,
    stagingStarted: receipt.stagingStarted === true,
    cleanup: {
      attempted: receipt.cleanup?.attempted === true,
      cleared: typeof receipt.cleanup?.cleared === 'boolean' ? receipt.cleanup.cleared : null,
    },
  };
}

async function readLegacyReceiptForNode(canvasFilePath, nodeId) {
  if (await hasBasenameCanvasCollision(canvasFilePath)) return null;
  const priorScopedPath = priorScopedLastRunReceiptPathForCanvas(canvasFilePath, nodeId);
  if (priorScopedPath) {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(priorScopedPath, 'utf8'));
      if (normalizeNodeId(parsed?.nodeId) === nodeId) return parsed;
    } catch { /* fall through to baseline singleton */ }
  }
  const legacyPath = lastRunReceiptPathForCanvas(canvasFilePath);
  if (!legacyPath) return null;
  try {
    const parsed = JSON.parse(await fs.promises.readFile(legacyPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const recordedOwner = normalizeNodeId(parsed.nodeId);
    return !recordedOwner || recordedOwner === nodeId ? parsed : null;
  } catch {
    return null;
  }
}

function readLegacyReceiptForNodeSync(canvasFilePath, nodeId) {
  // Synchronous report assembly cannot await the collision check. Refuse the
  // old basename fallback whenever both spellings exist; current hashed paths
  // are read before this helper.
  const scope = jobRunPathScopeForCanvas(canvasFilePath);
  if (!scope) return null;
  for (const candidate of [path.join(scope.dir, scope.base), path.join(scope.dir, `${scope.base}.json`)]) {
    if (candidate !== scope.canvasPath && fs.existsSync(candidate)) return null;
  }
  const priorScopedPath = priorScopedLastRunReceiptPathForCanvas(canvasFilePath, nodeId);
  if (priorScopedPath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(priorScopedPath, 'utf8'));
      if (normalizeNodeId(parsed?.nodeId) === nodeId) return parsed;
    } catch { /* fall through to baseline singleton */ }
  }
  const legacyPath = lastRunReceiptPathForCanvas(canvasFilePath);
  if (!legacyPath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const recordedOwner = normalizeNodeId(parsed.nodeId);
    return !recordedOwner || recordedOwner === nodeId ? parsed : null;
  } catch {
    return null;
  }
}

export async function readLastRunReceipt(canvasFilePath, nodeIdOrOptions = null) {
  const filePath = lastRunReceiptPathForCanvas(canvasFilePath, nodeIdOrOptions);
  if (!filePath) return null;
  try {
    if (!normalizeNodeId(nodeIdOrOptions) && await hasBasenameCanvasCollision(canvasFilePath)) {
      throw new Error('ambiguous-basename-legacy-receipt');
    }
    const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const nodeId = normalizeNodeId(nodeIdOrOptions);
    return !nodeId || normalizeNodeId(parsed.nodeId) === nodeId ? parsed : null;
  } catch {
    // Receipts used to be canvas-singleton. A scoped caller can consult ONLY
    // that legacy singleton when it was unowned or belonged to this hub; it
    // must never fall through to another modern hub's receipt.
    const nodeId = normalizeNodeId(nodeIdOrOptions);
    if (nodeId) return readLegacyReceiptForNode(canvasFilePath, nodeId);
    // As with manifests, a legacy caller can safely consume exactly one modern
    // receipt while it migrates to nodeId-aware reads. Multiple receipts are
    // intentionally ambiguous and therefore never selected implicitly.
    try {
      const scope = jobRunPathScopeForCanvas(canvasFilePath);
      if (!scope) return null;
      const names = await fs.promises.readdir(scope.dir);
      const matches = names.filter(name => name.startsWith(`${scope.base}.jobs-last-run.${scope.canvasHash}.`) && name.endsWith('.json'));
      if (matches.length === 1) {
        const parsed = JSON.parse(await fs.promises.readFile(path.join(scope.dir, matches[0]), 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
      }
    } catch { /* no usable unambiguous receipt */ }
    return null;
  }
}

/** Synchronous companion for bug-report assembly, which is intentionally sync. */
export function readLastRunReceiptSync(canvasFilePath, nodeIdOrOptions = null) {
  const filePath = lastRunReceiptPathForCanvas(canvasFilePath, nodeIdOrOptions);
  if (!filePath) return null;
  try {
    if (!normalizeNodeId(nodeIdOrOptions)) {
      const scope = jobRunPathScopeForCanvas(canvasFilePath);
      if (scope && [path.join(scope.dir, scope.base), path.join(scope.dir, `${scope.base}.json`)]
        .some(candidate => candidate !== scope.canvasPath && fs.existsSync(candidate))) {
        throw new Error('ambiguous-basename-legacy-receipt');
      }
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const nodeId = normalizeNodeId(nodeIdOrOptions);
    return !nodeId || normalizeNodeId(parsed.nodeId) === nodeId ? parsed : null;
  } catch {
    const nodeId = normalizeNodeId(nodeIdOrOptions);
    if (nodeId) return readLegacyReceiptForNodeSync(canvasFilePath, nodeId);
    try {
      const scope = jobRunPathScopeForCanvas(canvasFilePath);
      if (!scope) return null;
      const matches = fs.readdirSync(scope.dir)
        .filter(name => name.startsWith(`${scope.base}.jobs-last-run.${scope.canvasHash}.`) && name.endsWith('.json'));
      if (matches.length === 1) {
        const parsed = JSON.parse(fs.readFileSync(path.join(scope.dir, matches[0]), 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
      }
    } catch { /* no usable unambiguous receipt */ }
    return null;
  }
}

/** Direct, token-guarded receipt write for focused tests/support tooling. */
export async function writeLastRunReceipt(canvasFilePath, receipt, { expectedRunId = null, nodeId = null } = {}) {
  const filePath = lastRunReceiptPathForCanvas(canvasFilePath, nodeId || receipt?.nodeId || null);
  if (!filePath) return { written: false, receipt: null };
  return withReceiptLock(filePath, async () => {
    const current = await readLastRunReceipt(canvasFilePath, nodeId || receipt?.nodeId || null);
    if (expectedRunId != null && current?.runId !== expectedRunId) {
      return { written: false, receipt: current, tokenMismatch: true };
    }
    const sanitized = sanitizeLastRunReceipt(receipt);
    if (!sanitized.runId) return { written: false, receipt: current, invalid: true };
    try {
      await atomicWriteJson(filePath, sanitized);
      return { written: true, receipt: sanitized };
    } catch (error) {
      logger.warn(`[JobRunStaging] writeLastRunReceipt failed: ${error?.message || error}`);
      return { written: false, receipt: current, error: String(error?.message || error) };
    }
  });
}

async function readManifestFromFiles(files) {
  if (!files) return null;
  try {
    const raw = await fs.promises.readFile(files.manifest, 'utf8');
    const manifest = JSON.parse(raw);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
    // Version-1 manifests predate Job Preferences. Materializing neutral
    // defaults here lets all recovery consumers use one contract, while still
    // keeping the old run's ordinary query/location semantics intact.
    const inputs = manifest.inputs && typeof manifest.inputs === 'object' && !Array.isArray(manifest.inputs)
      ? manifest.inputs
      : {};
    return {
      ...manifest,
      inputs: {
        ...inputs,
        jobPreferences: sanitizeJobPreferences(inputs.jobPreferences),
        jobPreferencePlan: sanitizeJobPreferencePlan(inputs.jobPreferencePlan),
      },
    };
  } catch {
    return null; // missing or corrupt → treated as "no run"
  }
}

// Locate one hub's ledger. A node-scoped ledger always wins. If it has not
// been created yet, a legacy singleton may be resumed by its recorded owner
// (or deliberately handled as owner-unknown); it is never moved or replaced as
// an incidental side effect of opening another hub.
async function locateRun(canvasFilePath, nodeIdOrOptions = null) {
  const nodeId = normalizeNodeId(nodeIdOrOptions);
  const files = runFilesForCanvas(canvasFilePath, nodeId);
  if (!files) return { files: null, manifest: null };
  const manifest = !nodeId && await hasBasenameCanvasCollision(canvasFilePath)
    ? null
    : await readManifestFromFiles(files);
  if (manifest) {
    // Filename hashes are routing hints, never ownership authority. A corrupt
    // or deliberately planted file at this path must not pair another hub's
    // manifest with this hub's staging ledger.
    if (!nodeId || normalizeNodeId(manifest.inputs?.nodeId) === nodeId) return { files, manifest, legacy: false };
    return { files, manifest: null, legacy: false };
  }
  if (!nodeId) {
    // Preserve incremental callers from the singleton era when the canvas has
    // exactly one modern hub ledger. Ambiguity is intentionally a miss: callers
    // that could otherwise cross hubs must pass a nodeId.
    try {
      const scope = jobRunPathScopeForCanvas(canvasFilePath);
      if (!scope) return { files, manifest: null, legacy: false };
      const names = await fs.promises.readdir(scope.dir);
      const matches = names.filter(name => name.startsWith(`${scope.base}.jobs-run.${scope.canvasHash}.`) && name.endsWith('.json'));
      const candidates = [];
      for (const name of matches) {
        const candidateFiles = {
          staging: path.join(scope.dir, name.replace(/\.jobs-run\.(.+)\.json$/, '.jobs-staging.$1.jsonl')),
          manifest: path.join(scope.dir, name),
          nodeId: null,
          legacy: false,
        };
        const candidate = await readManifestFromFiles(candidateFiles);
        const candidateNodeId = normalizeNodeId(candidate?.inputs?.nodeId);
        if (!candidate || !candidateNodeId) continue;
        candidates.push({ files: { ...candidateFiles, nodeId: candidateNodeId }, manifest: candidate });
      }
      if (candidates.length === 1) return { ...candidates[0], legacy: false };
    } catch { /* missing/unreadable canvas directory behaves as no run */ }
    return { files, manifest: null, legacy: false };
  }

  const collision = await hasBasenameCanvasCollision(canvasFilePath);
  const priorScopedFiles = priorScopedRunFilesForCanvas(canvasFilePath, nodeId);
  const priorScopedManifest = !collision ? await readManifestFromFiles(priorScopedFiles) : null;
  const priorScopedOwner = normalizeNodeId(priorScopedManifest?.inputs?.nodeId);
  if (priorScopedManifest && priorScopedOwner === nodeId) {
    return { files: priorScopedFiles, manifest: priorScopedManifest, legacy: true };
  }
  const legacyFiles = runFilesForCanvas(canvasFilePath);
  const legacyManifest = !collision ? await readManifestFromFiles(legacyFiles) : null;
  const legacyOwner = normalizeNodeId(legacyManifest?.inputs?.nodeId);
  if (legacyManifest && (!legacyOwner || legacyOwner === nodeId)) {
    return { files: legacyFiles, manifest: legacyManifest, legacy: true };
  }
  return { files, manifest: null, legacy: false };
}

// The preference plan comes from model output, but becomes durable recovery
// input. Keep the persisted form deliberately small and data-only: a corrupt
// or future plan must not make a saved canvas impossible to resume, and we do
// not retain arbitrary model payloads merely because they happened to be
// adjacent to the useful plan fields.
function manifestText(value, max = 1000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function manifestTextList(value, { maxItems = 30, maxItemLength = 280 } = {}) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => manifestText(item, maxItemLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function sanitizeManifestPreferenceRows(value, strict) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).flatMap((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
    const criterion = manifestText(row.criterion, 600);
    if (!criterion) return [];
    const id = manifestText(row.id, 100) || `${strict ? 'strict' : 'soft'}-${index + 1}`;
    const category = manifestText(row.category, 100);
    return [{ id, criterion, ...(category ? { category } : {}) }];
  });
}

/**
 * Make a durable, backwards-compatible subset of the preference interpreter's
 * model result. This is intentionally exported for regression tests; callers
 * should keep treating a null plan as "interpret again" rather than a failed
 * recovery.
 */
export function sanitizeJobPreferencePlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const directionValue = value.direction && typeof value.direction === 'object' && !Array.isArray(value.direction)
    ? value.direction
    : {};
  const direction = {
    summary: manifestText(directionValue.summary, 1000),
    roleDirections: manifestTextList(directionValue.roleDirections),
    avoidDirections: manifestTextList(directionValue.avoidDirections),
    explorationEnabled: directionValue.explorationEnabled === true,
  };
  const plan = {
    // Plans are intentionally normalized to the only format this build can
    // resume. Future versions fall back to their raw Job Preferences text.
    version: 1,
    summary: manifestText(value.summary, 1000),
    direction,
    softPreferences: sanitizeManifestPreferenceRows(value.softPreferences, false),
    strictRequirements: sanitizeManifestPreferenceRows(value.strictRequirements, true),
    warnings: manifestTextList(value.warnings, { maxItems: 10, maxItemLength: 500 }),
    targetRoleConflict: value.targetRoleConflict === true,
    targetRoleConflictReason: value.targetRoleConflict === true
      ? manifestText(value.targetRoleConflictReason, 1000)
      : '',
  };
  const meaningful = plan.summary
    || plan.direction.summary
    || plan.direction.roleDirections.length > 0
    || plan.direction.avoidDirections.length > 0
    || plan.direction.explorationEnabled
    || plan.softPreferences.length > 0
    || plan.strictRequirements.length > 0
    || plan.warnings.length > 0
    || plan.targetRoleConflict;
  return meaningful ? plan : null;
}

export function sanitizeJobPreferences(value) {
  // The renderer bounds this input, but IPC callers and old canvases can bypass
  // it. Match the backend cap so manifests remain small and deterministic.
  return typeof value === 'string' ? value.trim().slice(0, 4000) : '';
}

/**
 * Begin a run: write a fresh manifest (stage='searching') and truncate any prior
 * staging file. `runId`/`startedAt` are passed in (callers stamp time, since the
 * test runner forbids Date.now()). Returns the manifest, or null if no canvas.
 */
export async function startRun(canvasFilePath, { runId, startedAt, queries = [], profileFingerprint = null, targetRole = null, jobPreferences = '', jobPreferencePlan = null, canonicalLocation = '', maxAgeDays = null, collectionLimits = null, nodeId = null, sourceIds = [] }) {
  const ownerNodeId = normalizeNodeId(nodeId);
  const files = runFilesForCanvas(canvasFilePath, ownerNodeId);
  if (!files) return null;
  const sources = {};
  for (const id of sourceIds) sources[id] = { status: 'pending', queries: {} };
  const manifest = {
    version: MANIFEST_VERSION,
    runId, startedAt, lastUpdated: startedAt,
    stage: 'searching',
    inputs: {
      queries,
      profileFingerprint,
      targetRole,
      jobPreferences: sanitizeJobPreferences(jobPreferences),
      jobPreferencePlan: sanitizeJobPreferencePlan(jobPreferencePlan),
      canonicalLocation,
      maxAgeDays,
      collectionLimits,
      nodeId: ownerNodeId,
    },
    sources,
  };
  const result = await withManifestLock(files.manifest, async () => {
    // Each hub owns its own staging ledger. This lock only serializes one
    // hub's replacement, so another hub can continue its recoverable search
    // independently while same-hub reruns retain the established fencing.
    const existing = await readManifestFromFiles(files);
    const existingNodeId = normalizeNodeId(existing?.inputs?.nodeId);
    if (existing && ownerNodeId && existingNodeId !== ownerNodeId) {
      // A legacy manifest without node ownership is still a real unfinished
      // recovery record. Treat its owner as unknown rather than overwriting it
      // from a different modern hub and losing its staged pages. An explicit
      // Reset/Discard remains the deliberate escape hatch for that legacy run.
      return {
        conflict: true,
        ownerNodeId: existingNodeId,
        ownerUnknown: !existingNodeId,
        ownerRunId: existing.runId || null,
      };
    }
    // A legacy singleton belongs to no scoped filename. Never let a new run
    // silently hide it behind this hub's new sidecar: its recorded owner (or an
    // unknown legacy owner) must Resume/Discard it explicitly first. A legacy
    // run owned by another hub does not block this hub because the new files do
    // not overwrite or mutate it.
    if (!existing && ownerNodeId) {
      const collision = await hasBasenameCanvasCollision(canvasFilePath);
      const priorScopedFiles = priorScopedRunFilesForCanvas(canvasFilePath, ownerNodeId);
      const priorScoped = !collision ? await readManifestFromFiles(priorScopedFiles) : null;
      const priorOwner = normalizeNodeId(priorScoped?.inputs?.nodeId);
      if (priorScoped && priorOwner === ownerNodeId) {
        return {
          conflict: true,
          ownerNodeId: priorOwner,
          ownerUnknown: false,
          ownerRunId: priorScoped.runId || null,
          legacy: true,
        };
      }
      const legacyFiles = runFilesForCanvas(canvasFilePath);
      const legacy = !collision ? await readManifestFromFiles(legacyFiles) : null;
      const legacyOwner = normalizeNodeId(legacy?.inputs?.nodeId);
      if (legacy && (!legacyOwner || legacyOwner === ownerNodeId)) {
        return {
          conflict: true,
          ownerNodeId: legacyOwner,
          ownerUnknown: !legacyOwner,
          ownerRunId: legacy.runId || null,
          legacy: true,
        };
      }
    }
    // Do not truncate the prior recovery file until the replacement manifest
    // has committed. A manifest write can fail (read-only volume, a path that
    // was replaced by a directory, disk-full), and losing the old JSONL while
    // its old manifest remains would turn a recoverable run into an empty one.
    // This is a rollback guard for ordinary I/O failures; the two sidecars
    // cannot be made one filesystem-atomic unit across a sudden power loss.
    const stagingBackup = `${files.staging}.${process.pid}.${_tmpSeq++}.bak`;
    let movedPriorStaging = false;
    let createdFreshStaging = false;
    try {
      try {
        await fs.promises.rename(files.staging, stagingBackup);
        movedPriorStaging = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      // `wx` prevents a concurrent external writer from being silently
      // truncated between the move above and this fresh-run initialization.
      await fs.promises.writeFile(files.staging, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      createdFreshStaging = true;
      await atomicWriteJson(files.manifest, manifest);
      if (movedPriorStaging) await fs.promises.unlink(stagingBackup).catch((error) => {
        // The new run is already valid. Retain the backup for manual recovery
        // rather than falsely reporting start failure after its commit.
        logger.warn(`[JobRunStaging] could not remove prior staging backup: ${error?.message || error}`);
      });
      return { started: true };
    } catch (e) {
      if (createdFreshStaging) await fs.promises.unlink(files.staging).catch(() => {});
      if (movedPriorStaging) {
        try { await fs.promises.rename(stagingBackup, files.staging); }
        catch (restoreError) {
          // Leave the backup in place rather than deleting the user's only
          // recoverable copy. The warning gives support a concrete path.
          logger.warn(`[JobRunStaging] could not restore prior staging from ${stagingBackup}: ${restoreError?.message || restoreError}`);
        }
      }
      logger.warn(`[JobRunStaging] startRun failed: ${e?.message || e}`);
      return { started: false };
    }
  });
  if (result?.conflict) return result;
  return result?.started ? manifest : null;
}

/**
 * Flush one page's raw jobs to staging and bump the (source,query) ledger.
 * `now` is the caller-stamped timestamp. `expectedRunId` makes late work from
 * a cancelled predecessor a no-op after a fresh run has replaced the manifest.
 * No-op when there is no canvas/manifest.
 */
export async function recordSourcePage(canvasFilePath, { sourceId, query = '', page = 0, jobs = [], now, expectedRunId = null, nodeId = null }) {
  const located = await locateRun(canvasFilePath, nodeId);
  const { files } = located;
  if (!files) return;
  return withManifestLock(files.manifest, async () => {
    try {
      // Check the token BEFORE appending: a manifest write is atomic, whereas
      // staging is append-only and cannot be rolled back after an old run has
      // leaked rows into its successor's file.
      const manifest = await readManifestFromFiles(files);
      if (!manifest || (expectedRunId != null && manifest.runId !== expectedRunId)) return false;
      if (Array.isArray(jobs) && jobs.length > 0) {
        const lines = jobs.map(j => JSON.stringify({ sourceId, query, page, job: j })).join('\n') + '\n';
        await fs.promises.appendFile(files.staging, lines, { encoding: 'utf8', mode: 0o600 });
      }
      const src = manifest.sources[sourceId] || (manifest.sources[sourceId] = { status: 'pending', queries: {} });
      const q = src.queries[query] || (src.queries[query] = { lastPage: -1 });
      q.lastPage = Math.max(q.lastPage ?? -1, page);
      manifest.lastUpdated = now ?? manifest.lastUpdated;
      await atomicWriteJson(files.manifest, manifest);
      return true;
    } catch (e) {
      // Staging is best-effort recovery scaffolding — never let it break a scrape.
      logger.warn(`[JobRunStaging] recordSourcePage(${sourceId}) failed: ${e?.message || e}`);
    }
  });
}

/** Set a source's terminal status ('done' | 'blocked') for the expected run. */
export async function markSourceStatus(canvasFilePath, sourceId, status, now, { expectedRunId = null, nodeId = null } = {}) {
  const located = await locateRun(canvasFilePath, nodeId);
  const { files } = located;
  if (!files) return;
  return withManifestLock(files.manifest, async () => {
    const manifest = await readManifestFromFiles(files);
    if (!manifest || (expectedRunId != null && manifest.runId !== expectedRunId)) return false;
    const src = manifest.sources[sourceId] || (manifest.sources[sourceId] = { status: 'pending', queries: {} });
    src.status = status;
    manifest.lastUpdated = now ?? manifest.lastUpdated;
    try { await atomicWriteJson(files.manifest, manifest); return true; }
    catch (e) { logger.warn(`[JobRunStaging] markSourceStatus failed: ${e?.message || e}`); }
  });
}

/** Advance the pipeline stage ('searching'→'gathered'; see the header). */
export async function setStage(canvasFilePath, stage, now, { expectedRunId = null, nodeId = null } = {}) {
  const located = await locateRun(canvasFilePath, nodeId);
  const { files } = located;
  if (!files) return;
  return withManifestLock(files.manifest, async () => {
    const manifest = await readManifestFromFiles(files);
    if (!manifest || (expectedRunId != null && manifest.runId !== expectedRunId)) return false;
    manifest.stage = stage;
    manifest.lastUpdated = now ?? manifest.lastUpdated;
    try { await atomicWriteJson(files.manifest, manifest); return true; }
    catch (e) { logger.warn(`[JobRunStaging] setStage failed: ${e?.message || e}`); }
  });
}

/** Parse one resolved staging JSONL, skipping torn/garbage lines. */
async function readStagedJobsFromFiles(files) {
  if (!files) return [];
  let raw;
  try { raw = await fs.promises.readFile(files.staging, 'utf8'); }
  catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* torn last line after a crash — skip */ }
  }
  return out;
}

/** Parse the staging JSONL, skipping any torn/garbage lines. Returns [] on miss. */
export async function readStagedJobs(canvasFilePath, nodeIdOrOptions = null) {
  const { files } = await locateRun(canvasFilePath, nodeIdOrOptions);
  return readStagedJobsFromFiles(files);
}

/**
 * Read the full run state for resume detection. Returns null when there is no
 * (parseable) manifest. `resumable` is true when the run did not finish AND is
 * recent enough to auto-offer (within RESUMABLE_MAX_AGE_MS of `now`).
 */
export async function readRunState(canvasFilePath, now = null, nodeIdOrOptions = null) {
  const located = await locateRun(canvasFilePath, nodeIdOrOptions);
  const { manifest } = located;
  if (!manifest) return null;
  // A manifest on disk IS an unfinished run — clean finishes delete the
  // sidecars (see header). `incomplete` is kept on the return shape for the
  // renderer's peek payload rather than re-derived at every consumer.
  const incomplete = true;
  const ageMs = (typeof now === 'number' && typeof manifest.lastUpdated === 'number')
    ? now - manifest.lastUpdated
    : null;
  const recent = ageMs == null ? true : ageMs <= RESUMABLE_MAX_AGE_MS;
  // Reuse the exact ledger locateRun selected. Re-locating by its nullable
  // `files.nodeId` would make an owned legacy manifest accidentally read the
  // sole modern hub's staging file during a migration.
  const stagedJobs = await readStagedJobsFromFiles(located.files);
  return { manifest, stagedJobs, incomplete, ageMs, resumable: incomplete && recent, legacy: located.legacy === true };
}

/**
 * 1-based page a URL-paginated source should resume from, given its manifest
 * ledger. Fast-forwards to min(lastPage)+1 ONLY when every query of the run
 * recorded at least one page — buildJobTasks applies ONE start page to EVERY
 * query of the source, and a query that crashed before flushing its first page
 * has no ledger entry, so fast-forwarding past page min(...) would silently
 * skip that query's early pages. Any unrecorded query ⇒ restart at page 1
 * (the cross-source dedup absorbs the re-scraped overlap).
 *
 * @param {object} sourceLedger  manifest.sources[sid] ({ queries: { [q]: { lastPage } } })
 * @param {number} totalQueryCount  how many queries the run scrapes per source
 * @returns {number} 1-based start page
 */
export function computeResumeStartPage(sourceLedger, totalQueryCount) {
  const qmap = sourceLedger?.queries || {};
  const pages = Object.values(qmap)
    .map(q => q?.lastPage)
    .filter(n => typeof n === 'number' && n >= 0);
  const allQueriesRecorded = pages.length >= Math.max(1, totalQueryCount | 0);
  return (pages.length && allQueriesRecorded) ? Math.min(...pages) + 1 : 1;
}

/**
 * Remove both sidecars.
 *
 * @param {string} canvasFilePath
 * @param {object} [opts]
 * @param {(path:string)=>Promise<void>} [opts.trashItem] - When provided (e.g.
 *   electron `shell.trashItem`), move the sidecars to the OS Trash instead of
 *   hard-deleting, so an accidental "Start fresh" is recoverable. A clean finish
 *   passes nothing and hard-deletes — there's nothing to recover, and trashing a
 *   sidecar on every successful run would steadily clutter the Trash. The
 *   function is INJECTED, not imported, so this module stays electron-free and
 *   unit-testable in the plain-node runner.
 */
export async function clearRunWithResult(canvasFilePath, { trashItem = null, expectedRunId = null, expectedNodeId = null, expectedOwnerUnknown = false } = {}) {
  const located = await locateRun(canvasFilePath, expectedNodeId);
  const { files } = located;
  if (!files) return { ok: true, cleared: false, absent: true, reason: 'missing-canvas' };
  return withManifestLock(files.manifest, async () => {
    // Completion is renderer-driven and may arrive after the user has already
    // started another search on this canvas. Compare under the same manifest
    // lock as startRun so an old completion can never delete a newer run.
    if (expectedRunId != null || expectedNodeId != null || expectedOwnerUnknown) {
      const manifest = await readManifestFromFiles(files);
      if (!manifest) return { ok: true, cleared: false, absent: true, reason: 'run-absent' };
      if ((expectedRunId != null && manifest.runId !== expectedRunId)
        || (expectedNodeId != null && manifest.inputs?.nodeId !== expectedNodeId)
        || (expectedOwnerUnknown && manifest.inputs?.nodeId)) {
        return { ok: true, cleared: false, tokenMismatch: true, reason: 'ownership-mismatch' };
      }
    }
    const cleared = await clearRunFiles(files, trashItem);
    return {
      ok: cleared,
      cleared,
      reason: cleared ? null : 'cleanup-failed',
    };
  });
}

export async function clearRun(canvasFilePath, options = {}) {
  const result = await clearRunWithResult(canvasFilePath, options);
  return result.cleared === true;
}

async function clearRunFiles(files, trashItem = null) {
  const removeAndVerify = async (p) => {
    // Skip a sidecar that isn't there (a run may have only one, or it was
    // already cleared) so trashItem doesn't error on a missing path.
    try {
      await fs.promises.access(p);
    } catch (error) {
      if (error?.code === 'ENOENT') return true;
      // An access failure does not prove absence. Keep the aggregate cleanup
      // verdict false rather than issuing a terminal receipt that claims an
      // unreadable or temporarily unavailable sidecar was removed.
      logger.warn(`[JobRunStaging] Could not inspect ${p} before cleanup: ${error?.message || error}`);
      return false;
    }
    if (trashItem) {
      try {
        await trashItem(p);
      } catch (err) {
        // trashItem can fail on volumes without a Trash (network / exFAT). Fall
        // back to a hard delete so "Start fresh" still clears the run rather
        // than leaving a stale resumable manifest behind.
        logger.warn(`[JobRunStaging] trashItem failed for ${p} (${err?.message || err}); hard-deleting instead`);
        try { await fs.promises.unlink(p); } catch { /* verified below */ }
      }
    } else {
      try { await fs.promises.unlink(p); } catch { /* verified below */ }
    }
    try {
      await fs.promises.access(p);
      return false;
    } catch (error) {
      // Only a definite missing-path result verifies deletion. Permission,
      // device, and other I/O failures leave cleanup unconfirmed.
      if (error?.code !== 'ENOENT') {
        logger.warn(`[JobRunStaging] Could not verify cleanup of ${p}: ${error?.message || error}`);
        return false;
      }
      return true;
    }
  };

  // The manifest is the discoverability/ownership record for the staged rows.
  // Never remove it while staging still exists: doing so leaves private job data
  // orphaned and makes an exact cleanup retry impossible. Deleting staging first
  // can still leave a manifest-only partial state, but that state is safe and
  // intentionally finalized by retrying the exact terminal receipt.
  const stagingCleared = await removeAndVerify(files.staging);
  if (!stagingCleared) return false;
  return removeAndVerify(files.manifest);
}

/**
 * Atomically records a redacted terminal receipt before removing recovery
 * sidecars, then records the actual cleanup outcome. The manifest token is
 * checked under the same lock as startRun/clearRun, so a delayed completion from
 * an older hub run cannot overwrite a newer run's receipt or delete its files.
 */
export async function completeRunWithReceipt(canvasFilePath, receipt, { trashItem = null, expectedNodeId = null } = {}) {
  const located = await locateRun(canvasFilePath, expectedNodeId || receipt?.nodeId || null);
  const { files } = located;
  const receiptPath = lastRunReceiptPathForCanvas(canvasFilePath, files?.nodeId);
  const expectedRunId = String(receipt?.runId || '');
  if (!files || !receiptPath || !expectedRunId) {
    return { ok: false, cleared: false, receipt: null, reason: 'missing-canvas-or-run-token' };
  }
  return withManifestLock(files.manifest, async () => withReceiptLock(receiptPath, async () => {
    const manifest = await readManifestFromFiles(files);
    let existingReceipt = null;
    try {
      const parsed = JSON.parse(await fs.promises.readFile(receiptPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existingReceipt = sanitizeLastRunReceipt(parsed);
      }
    } catch { /* a first completion legitimately has no prior receipt */ }
    const expectedOwner = normalizeNodeId(expectedNodeId || receipt?.nodeId);
    const exactExistingReceipt = !!existingReceipt?.runId
      && existingReceipt.runId === expectedRunId
      && (!expectedOwner || normalizeNodeId(existingReceipt.nodeId) === expectedOwner);

    if (manifest && (
      manifest.runId !== expectedRunId
      || (expectedOwner != null && normalizeNodeId(manifest.inputs?.nodeId) !== expectedOwner)
    )) {
      return { ok: false, cleared: false, receipt: null, tokenMismatch: true };
    }

    // A prior completion can have removed the manifest and staging successfully,
    // then failed only while updating the receipt, or it can have left a single
    // residual sidecar. The exact durable receipt is sufficient authority to
    // finish that cleanup idempotently; never reinterpret this as a scrape to
    // resume. Without either an exact manifest or exact receipt, fail closed.
    if (!manifest && !exactExistingReceipt) {
      return { ok: false, cleared: false, receipt: existingReceipt, tokenMismatch: true };
    }

    const initial = exactExistingReceipt
      ? existingReceipt
      : sanitizeLastRunReceipt({
          ...receipt,
          // Do not use process-global telemetry as a fallback here. The manifest
          // is this run's durable owner and safely fills identity/timing only
          // when the receipt builder could not match in-memory telemetry.
          nodeId: receipt?.nodeId || manifest?.inputs?.nodeId || null,
          startedAt: receipt?.startedAt ?? manifest?.startedAt,
          stagingStarted: true,
          cleanup: { attempted: false, cleared: null },
        });
    if (!exactExistingReceipt) {
      try {
        await atomicWriteJson(receiptPath, initial);
      } catch (error) {
        logger.warn(`[JobRunStaging] completion receipt write failed: ${error?.message || error}`);
        return { ok: false, cleared: false, receipt: null, receiptWriteFailed: true };
      }
    }

    const cleared = await clearRunFiles(files, trashItem);
    const completed = sanitizeLastRunReceipt({
      ...initial,
      updatedAt: Date.now(),
      cleanup: { attempted: true, cleared },
    });
    try {
      await atomicWriteJson(receiptPath, completed);
      return { ok: true, cleared, receipt: completed };
    } catch (error) {
      // The pre-cleanup receipt is still durable, explicitly showing that cleanup
      // had not yet been confirmed. Do not falsely claim a fully recorded finish.
      logger.warn(`[JobRunStaging] completion receipt cleanup update failed: ${error?.message || error}`);
      return { ok: false, cleared, receipt: initial, receiptUpdateFailed: true };
    }
  }));
}
