import { isRendererSensitivePath, registerRendererPrivateAppRoot } from '../utils/pathSafety.js';
import path from 'path';
import fs from 'fs';
import electronPkg from 'electron';
import {
  compensationCohortAssessmentMaxTokens,
  jobPreferenceResearchAssessmentMaxTokens,
  jobPreferenceResearchMaxTokens,
  jobScoringMaxTokens,
  listingEvaluationMaxTokens,
  BATCH_OUTPUT_TOKEN_BUDGET,
  marketplaceHubScanBatchMaxTokens,
  priceSynthesisBatchMaxTokens,
  roleFamilyAssessmentMaxTokens,
} from './resultCaps.js';
import { NON_API_AI_TRANSPORT, requestNonApiAi } from './nonApiAi.js';
import { KNOWN_TASKS, getKnownTaskIds } from './knownTasks.js';
import { logger } from '../logger.js';
import { CAREER_SNAPSHOT_TASK_OUTPUT_TOKEN_LIMITS } from './careerSnapshot.js';

/**
 * The typed AI call shapes (text/raw/vision) the rest of the app calls instead
 * of talking to requestNonApiAi directly. Every call becomes a handoff that the
 * local task worker answers, so no provider, model or
 * quality-tier selection happens here.
 */

/**
 * Per-task output sizing. The numbers follow the JSON each task returns and are
 * bounded by BATCH_OUTPUT_TOKEN_BUDGET, the model's official 128,000-token output
 * limit less a margin (see resultCaps.js). They are not sent to the model.
 *
 * A value may be a number (static cap) OR a function `(hints) => number`
 * that scales with input characteristics. Hints currently supported:
 *   - photoCount: number of images in a vision call
 *   - promptLength: chars in the text prompt
 *   - itemCount: e.g. number of jobs to score in one call
 */
const TASK_MAX_TOKENS = {
  // Product JSON scales with photo count: more photos → richer notable_features.
  // 1 photo ≈ 1024, 7 photos ≈ 2200, capped at 4096 so a 30-photo dump can't
  // request a runaway budget. The 1024 floor was what truncated the iPhone-XS
  // case on a 7-photo upload, so multi-photo cases now start above that.
  'vision-product-analysis':   ({ photoCount = 1 } = {}) =>
    Math.min(4096, 1024 + Math.max(0, photoCount - 1) * 200),
  // Thinking budget scales roughly linearly with comp count — the
  // anchor/adjusted/bound classification prompt asks the model to reason
  // about each item individually. Real-world calibration observed up to
  // ~200 tokens of reasoning per comp plus ~600 tokens of visible output; a
  // formula seed of 7000 was measured to truncate a 40-comp batch at 8383
  // tokens, so the floor moved well above that. 40 items → 11000 (headroom
  // above the observed 8648-token need).
  // Versioned item-keyed batches are packed by this exact formula in
  // marketplace.js. One Ki-token is reserved for the response envelope; each
  // independent pricing result gets 900 tokens plus 200 per supplied comp.
  'price-synthesis-batch':     ({ itemCount = 1, totalCompCount = 0 } = {}) =>
    priceSynthesisBatchMaxTokens(itemCount, totalCompCount),
  // Reasoning-heavy models can consume ~1460 thinking + ~50-230 visible
  // tokens for this task — real-world p95 is 1374, max 1510. 2048 sits above
  // the observed max so the cap is adequate on the first attempt (this
  // transport has no cap-raise retry to catch a truncation after the fact).
  'platform-fit-assessment':   2048,  // per-platform fit verdict + short reason
  // Bundle reasoning considers every item even though its visible explanation
  // stays bundle-only. Scale beyond the two-item baseline for thinking headroom.
  'bundle-price-synthesis':    ({ itemCount = 2 } = {}) =>
    Math.min(8192, 2048 + Math.max(0, itemCount - 2) * 350),
  // Hub scans return an attention list across a whole dashboard/feed. They are
  // packed by one conservative estimate in listingStatusCheck.js (a one-platform
  // scan is a batch of one): per-platform JSON/reasoning plus each hub page.
  'marketplace-hub-scan-batch': ({ platformCount = 1, urlCount = 1 } = {}) =>
    marketplaceHubScanBatchMaxTokens(platformCount, urlCount),
  // Career-profile compilation is a bounded structured evidence index.  Its
  // independent audit passes return discrepancy rows rather than copies of the
  // corpus, while repair returns the complete corrected candidate snapshot.
  'career-profile-compile': CAREER_SNAPSHOT_TASK_OUTPUT_TOKEN_LIMITS['career-profile-compile'],
  'career-profile-clean': CAREER_SNAPSHOT_TASK_OUTPUT_TOKEN_LIMITS['career-profile-clean'],
  'career-profile-audit-completeness': CAREER_SNAPSHOT_TASK_OUTPUT_TOKEN_LIMITS['career-profile-audit-completeness'],
  'career-profile-audit-grounding': CAREER_SNAPSHOT_TASK_OUTPUT_TOKEN_LIMITS['career-profile-audit-grounding'],
  'career-profile-audit-attribution': CAREER_SNAPSHOT_TASK_OUTPUT_TOKEN_LIMITS['career-profile-audit-attribution'],
  'career-profile-audit-metrics': CAREER_SNAPSHOT_TASK_OUTPUT_TOKEN_LIMITS['career-profile-audit-metrics'],
  'career-profile-audit-skills': CAREER_SNAPSHOT_TASK_OUTPUT_TOKEN_LIMITS['career-profile-audit-skills'],
  'career-profile-audit-conflicts': CAREER_SNAPSHOT_TASK_OUTPUT_TOKEN_LIMITS['career-profile-audit-conflicts'],
  'career-profile-repair': CAREER_SNAPSHOT_TASK_OUTPUT_TOKEN_LIMITS['career-profile-repair'],
  // Reasoning can consume the same cap as visible output on some models —
  // real-world: thoughts=979, visible=31 at cap=1024 truncated the JSON
  // mid-output. 4096 gives ~3000 headroom over
  // typical use (3 short query arrays ≈ 500 tokens visible + ~1000 thinking).
  'job-query-generation':      4096,  // 3 query arrays — small JSON, thinking-heavy
  // Whole-record scoring needs room for the complete professional-gap audit.
  // Four fresh jobs reserve 1,600 + 4*2,800 = 12,800 tokens. A one-job evidence
  // phase can separately name its requirement workload for output guidance.
  // One verdict object per listed gap row (about 160 tokens each) plus a
  // small per-job envelope. The row count is the real driver, so the caller
  // passes it as a hint; the job count alone is only a floor.
  'job-gap-review':            ({ itemCount = 1, reviewRowCount = 0 } = {}) =>
    Math.min(BATCH_OUTPUT_TOKEN_BUDGET, 1024 + Math.max(1, itemCount) * 256 + Math.max(0, reviewRowCount) * 160),
  // A handful of short pattern rows; the edited-bundle count is the only driver.
  'application-edit-recurrence': ({ itemCount = 3 } = {}) =>
    Math.min(BATCH_OUTPUT_TOKEN_BUDGET, 1024 + Math.max(1, itemCount) * 96),
  'job-scoring':               ({ itemCount = 10 } = {}) => jobScoringMaxTokens(itemCount),
  // Taxonomy planning is fed only bounded aggregate statistics and returns a
  // tiny role/range/mapping object, so it is sized small.
  'job-taxonomy-plan':         2048,
  // One integer per compact title row. The batcher packs as many rows as fit
  // 1,024 + 32 per row under BATCH_OUTPUT_TOKEN_BUDGET.
  'job-taxonomy-classify-batch': ({ itemCount = 1 } = {}) =>
    Math.min(BATCH_OUTPUT_TOKEN_BUDGET, 1024 + Math.max(1, itemCount) * 32),
  // One tiny yes/no verdict per near-match pair. The full descriptions are
  // input evidence; the response deliberately has no prose/reason field, so
  // it stays compact and every idle bridge worker can finish a four-pair batch
  // without reserving capacity needed by scoring or taxonomy.
  'job-location-consolidation-confirmation': ({ itemCount = 1 } = {}) =>
    Math.min(2048, 512 + Math.max(1, itemCount) * 128),
  'job-listing-liveness': ({ itemCount = 1 } = {}) =>
    Math.min(BATCH_OUTPUT_TOKEN_BUDGET, 1024 + Math.max(1, itemCount) * 160),
  'job-official-posting-research': ({ itemCount = 1 } = {}) =>
    Math.min(BATCH_OUTPUT_TOKEN_BUDGET, 1024 + Math.max(1, Math.floor(Number(itemCount) || 1)) * 700),
  // Each judgment copies the whole official description verbatim, so it gets the full usable answer.
  'job-official-posting-match': BATCH_OUTPUT_TOKEN_BUDGET,
  'job-compensation-research-batch': ({ roleFamilyCount = 0, cohortCount = 0, itemCount = 1 } = {}) => {
    const roles = Math.max(0, Number(roleFamilyCount) || 0);
    const cohorts = Math.max(0, Number(cohortCount) || 0);
    return Math.min(BATCH_OUTPUT_TOKEN_BUDGET,
      2048 + (roles > 0 ? roles * 1800 : Math.max(1, cohorts || itemCount) * 3000));
  },
  'job-compensation-assessment-batch': ({ roleFamilyCount = 0, cohortCount = 0, itemCount = 1 } = {}) => {
    const roles = Math.max(0, Number(roleFamilyCount) || 0);
    const cohorts = Math.max(0, Number(cohortCount) || 0);
    const rows = Math.max(1, Number(itemCount) || 1);
    return Math.min(BATCH_OUTPUT_TOKEN_BUDGET,
      roles > 0 ? roleFamilyAssessmentMaxTokens(roles) : compensationCohortAssessmentMaxTokens(Math.max(1, cohorts), rows));
  },
  'job-preference-interpretation': 4096,
  // Output volume here is listings × preference-plan items — the model writes
  // one match object per pair — so the cap is keyed on that PRODUCT, not on the
  // listing count. resultCaps owns the constants so this cap and the batch size
  // that feeds it are derived from the same numbers. The itemCount fallback
  // assumes an 8-item plan for callers that don't supply matchCount.
  'job-preference-evaluation': ({ matchCount, itemCount = 10 } = {}) =>
    listingEvaluationMaxTokens(
      Number.isFinite(matchCount) ? matchCount : itemCount * 8,
      itemCount,
    ),
  // Batched research scales its output size with the number
  // of employers it contains.
  // resultCaps owns both formulas so the batcher and its prompt cannot drift.
  'job-preference-research-batch': ({ itemCount = 1 } = {}) =>
    jobPreferenceResearchMaxTokens(itemCount),
  'job-preference-research-batch-assessment': ({ itemCount = 1 } = {}) =>
    jobPreferenceResearchAssessmentMaxTokens(itemCount),
  // Pass-2 role-resolution audit (JOB_ROLE_AUDIT_SCHEMA, jobPreferences.js's
  // resolveSearchRoles). Visible JSON is small — up to 20 final titles plus
  // up to 20 added/removed titles (worst case ~40 short title strings) and
  // three short prose fields (addedReason/removedReason/rationale, a few
  // hundred chars each) — well under job-preference-interpretation's full
  // plan (up to 24+24 preference items plus this same title list). Matched
  // to that task's cap anyway rather than shaved down: this call runs ONCE
  // per hub (the result is locked and reused verbatim forever after), a
  // reasoning-heavy model auditing two separate checks (coverage/compliance)
  // can spend materially more thinking tokens than the visible JSON implies.
  'job-role-audit': 4096,
  // The ONLY high-row-count task here. `job-role-screen-batch` prompts pack
  // as many rows as fit the shared BATCH_OUTPUT_TOKEN_BUDGET. Each emits
  // one tiny row per job — `{"index":199,"outcome":"mismatch","reason":"registered nurse role"}` is
  // about 20 tokens, and 'match'/'unclear' rows carry an empty reason and cost
  // ~13 — but 200 of them still far exceed the flat 'default' 2048 this task
  // silently fell through to before it was registered here, which truncated
  // the reply and failed the whole screen — inverting the point of screening on titles (see
  // screenJobRolesByTitle in jobPreferences.js: the batch is large precisely
  // so one handoff covers the pool). Provisioned at roughly double the
  // all-mismatch worst case: 1,024 + 48 tokens per row.
  'job-role-screen-batch':     ({ itemCount = 0 } = {}) =>
    Math.min(BATCH_OUTPUT_TOKEN_BUDGET, 1024 + Math.max(0, itemCount) * 48),
  'default':                   2048,
};

function resolveTask(task) {
  if (!task || !KNOWN_TASKS.has(task)) {
    logger.warn(`[LLM] Unmapped task='${task}', using 'default' (2048 max_tokens). Add it to KNOWN_TASKS (knownTasks.js) and TASK_MAX_TOKENS.`);
    return 'default';
  }
  return task;
}

export { getKnownTaskIds };

/** The task-specific output size that batches for this task are sized to. */
export function taskMaxTokensFor(task, hints = {}) {
  const t = resolveTask(task);
  const entry = TASK_MAX_TOKENS[t] ?? TASK_MAX_TOKENS['default'];
  return typeof entry === 'function' ? entry(hints) : entry;
}

// Local char→token estimate for the verdict below. It is informational
// only — checkPromptFits is always permissive, nothing is gated on this
// number — so a simple constant-ratio estimate is enough.
const LOCAL_CHARS_PER_TOKEN = 2.5;
function estimateTokensFromChars(chars) {
  return Math.ceil(Math.max(0, Number(chars) || 0) / LOCAL_CHARS_PER_TOKEN);
}

/**
 * Sizing/verdict info for a prompt this task would use. The model's context
 * window is far larger than any prompt the app builds, so this always returns
 * the permissive verdict below (`fits: true`, unbounded budget). Kept as its
 * own function, rather than inlined at call sites, because callers still rely on the
 * { fits, tokens, budget, reservedOutput, contextWindow } shape for
 * batch-sizing decisions (e.g. job-scoring's chunking).
 * @returns {Promise<{fits:boolean, tokens:number, model:string, provider:string,
 *   budget:number, reservedOutput:number, contextWindow:number, via:string}>}
 */
export async function checkPromptFits(prompt, opts = {}) {
  const { task, hints, responseSchema, cachedPrefix } = normalizeOpts(opts);
  const chars = (cachedPrefix?.length || 0) + (prompt?.length || 0)
    + (responseSchema ? JSON.stringify(responseSchema).length : 0);
  const requestedOutput = taskMaxTokensFor(task, hints);
  return {
    fits: true,
    tokens: estimateTokensFromChars(chars),
    model: 'non-api-ai',
    provider: 'non-api-ai',
    via: 'manual',
    budget: Number.MAX_SAFE_INTEGER,
    reservedOutput: requestedOutput,
    contextWindow: Number.MAX_SAFE_INTEGER,
  };
}

// ── Public callers ──────────────────────────────────────────────────────────
// All four accept an opts object with { signal, task }. `task` keys into
// TASK_MAX_TOKENS. `signal` is forwarded to the handoff so a cancelled
// operation also cancels its still-pending request.

function assertStructuredResponseSchema(responseSchema, caller) {
  if (responseSchema && typeof responseSchema === 'object' && !Array.isArray(responseSchema)) return;
  throw new Error(`${caller} requires a responseSchema. Use callLLMRaw for prose or grounded research.`);
}

/**
 * Structured (JSON-schema) text call.
 *
 * `cachedPrefix` — optional static string the caller wants inlined ahead of
 * the dynamic prompt (e.g. job-scoring batches sharing the same profile +
 * rules across calls). The task worker moves it into the system prompt so
 * the shared text is cached across a run.
 */
export async function callLLMText(prompt, opts = {}) {
  const { signal, task, hints, grounding, responseSchema, cachedPrefix, displayOnlyPromptSuffix, responseValidator, manualHandoff } = normalizeOpts(opts);
  assertStructuredResponseSchema(responseSchema, 'callLLMText');
  // Optional by-reference out-param: callers pass `meta: {}` and read back
  // `meta.model` for per-stage telemetry. There is only one transport, so
  // this is always 'non-api-ai', but the out-param contract stays the same
  // shape callers already expect.
  const meta = (opts.meta && typeof opts.meta === 'object') ? opts.meta : null;
  const result = await requestNonApiAi({
    prompt, cachedPrefix, task, responseSchema, grounding, batch: hints.batch, batchTotal: hints.batchTotal, itemCount: hints.itemCount,
    itemsDone: hints.itemsDone, itemsTotal: hints.itemsTotal, planItemCount: hints.planItemCount, matchCount: hints.matchCount,
    progressScopeId: hints.progressScopeId, progressUnitId: hints.progressUnitId, progressUnits: hints.progressUnits,
    queuedWorkForecast: hints.queuedWorkForecast,
    attemptKind: hints.attemptKind, rootBatchSize: hints.rootBatchSize,
    requestKind: 'structured-text', displayOnlyPromptSuffix, responseValidator,
    measureResponseUnits: opts?.measureResponseUnits, measureProgressUnits: opts?.measureProgressUnits, signal,
    canStepBack: manualHandoff.canStepBack,
    stepBackLabel: manualHandoff.stepBackLabel,
    initialResponse: manualHandoff.initialResponse,
    comparisonGroup: manualHandoff.comparisonGroup,
    comparisonRun: manualHandoff.comparisonRun,
    onHandoffAssigned: manualHandoff.onAssigned,
    onHandoffRoute: manualHandoff.onRoute,
  });
  if (meta) meta.model = 'non-api-ai';
  return result;
}

/**
 * Free-text generation — returns the model's raw string (NOT JSON-parsed).
 * Use for prose / HTML / research where a JSON envelope would be wrong.
 *
 * `grounding: true` adds an instruction to use WebSearch and WebFetch
 * (see materializeNonApiPrompt); the task's profile decides which tools the
 * worker is actually given.
 */
export async function callLLMRaw(prompt, opts = {}) {
  // These reviewed decisions use the same injected caller as research while
  // retaining the existing schema-backed JSON transport and validator path.
  if (opts.task === 'job-official-posting-match' && opts.responseSchema) return callLLMText(prompt, opts);
  const {
    signal,
    task,
    hints,
    grounding,
    cachedPrefix,
    displayOnlyPromptSuffix,
    responseValidator,
    manualHandoff,
  } = normalizeOpts(opts);
  const meta = (opts.meta && typeof opts.meta === 'object') ? opts.meta : null;
  const result = await requestNonApiAi({
    prompt, cachedPrefix, task, grounding, batch: hints.batch, batchTotal: hints.batchTotal, itemCount: hints.itemCount,
    itemsDone: hints.itemsDone, itemsTotal: hints.itemsTotal, planItemCount: hints.planItemCount, matchCount: hints.matchCount,
    progressScopeId: hints.progressScopeId, progressUnitId: hints.progressUnitId, progressUnits: hints.progressUnits,
    queuedWorkForecast: hints.queuedWorkForecast,
    attemptKind: hints.attemptKind, rootBatchSize: hints.rootBatchSize,
    requestKind: 'raw-text', displayOnlyPromptSuffix, responseValidator,
    measureProgressUnits: opts?.measureProgressUnits, signal,
    canStepBack: manualHandoff.canStepBack,
    stepBackLabel: manualHandoff.stepBackLabel,
    initialResponse: manualHandoff.initialResponse,
    comparisonGroup: manualHandoff.comparisonGroup,
    comparisonRun: manualHandoff.comparisonRun,
    onHandoffAssigned: manualHandoff.onAssigned,
    onHandoffRoute: manualHandoff.onRoute,
  });
  if (meta) meta.model = 'non-api-ai';
  return result;
}

const HOST_STAGED_VISION_READER = Symbol('host-staged-vision-reader');

// Only host code can install this closure. Renderer-owned options crossing IPC
// cannot carry the private Symbol, and source paths still pass the normal gate.
export function createHostStagedVisionCaller(assertOwnedPhotos, readOwnedPhoto) {
  if (typeof assertOwnedPhotos !== 'function' || typeof readOwnedPhoto !== 'function') {
    throw new TypeError('Host staged vision requires an ownership validator and reader.');
  }
  return async (imagePaths, prompt, opts = {}) => {
    await assertOwnedPhotos(imagePaths);
    return callLLMVision(imagePaths, prompt, { ...opts, [HOST_STAGED_VISION_READER]: readOwnedPhoto });
  };
}

/** Vision call — the photos are read from disk and sent to the worker with the prompt. */
export async function callLLMVision(imagePaths, prompt, opts = {}) {
  // Vision attachments are sourced from untrusted canvas JSON — imagePaths
  // comes from a node's saved
  // state, and a shared/untrusted canvas could point a node at a sensitive
  // system/credential path. Before this session this was enforced inside the
  // per-provider vision call sites themselves, each of which ran an
  // attachment-path safety check over every element of imagePaths before
  // touching the file. Those call sites are gone now that every call routes
  // through one handoff, so this is the replacement gate — it must run before
  // any path is read as an attachment.
  // Immutable recovery staging may replace the attachment path after hashing;
  // continue applying the sensitive-path policy to the original user-selected
  // source paths supplied by that trusted staging caller.
  const attachmentSafetyPaths = Array.isArray(opts?.attachmentSourcePaths)
    ? opts.attachmentSourcePaths
    : imagePaths;
  for (const imgPath of (Array.isArray(attachmentSafetyPaths) ? attachmentSafetyPaths : [])) {
    assertRendererAttachmentPathAllowed(imgPath);
  }
  const { signal, task, hints, responseSchema, responseValidator } = normalizeOpts(opts);
  assertStructuredResponseSchema(responseSchema, 'callLLMVision');
  const meta = (opts.meta && typeof opts.meta === 'object') ? opts.meta : null;
  const result = await requestNonApiAi({
    prompt, task, responseSchema, batch: hints.batch, batchTotal: hints.batchTotal, itemCount: hints.itemCount,
    itemsDone: hints.itemsDone, itemsTotal: hints.itemsTotal, planItemCount: hints.planItemCount, matchCount: hints.matchCount,
    progressScopeId: hints.progressScopeId, progressUnitId: hints.progressUnitId, progressUnits: hints.progressUnits,
    attemptKind: hints.attemptKind, rootBatchSize: hints.rootBatchSize,
    attachmentPaths: imagePaths, requestKind: 'structured-vision', responseValidator,
    attachmentReader: typeof opts?.[HOST_STAGED_VISION_READER] === 'function'
      ? opts[HOST_STAGED_VISION_READER] : readRendererAttachmentForBridge,
    measureProgressUnits: opts?.measureProgressUnits, signal,
  });
  if (meta) meta.model = 'non-api-ai';
  return result;
}

function rendererAttachmentPathError(filePath) {
  return new Error(`Refusing to read a sensitive system/credential path as an AI attachment: ${filePath}`);
}

function registerLlmRendererPrivateRoot() {
  try { registerRendererPrivateAppRoot(electronPkg.app?.getPath?.('userData')); } catch { /* app startup/test stubs can precede userData creation */ }
}

// Generic document/vision paths originate in renderer-controlled canvas
// state.  A lexical component check alone misses `ordinary.pdf ->
// career-input-staging/secret.pdf` and a public hard-link alias.  This is not
// the host-stage path: its private Symbol capability is checked separately
// after jobs.js proves its run ownership and inode identities.
function assertRendererAttachmentPathAllowed(filePath) {
  const normalizedPath = path.resolve(String(filePath || ''));
  registerLlmRendererPrivateRoot();
  if (isRendererSensitivePath(normalizedPath)) throw rendererAttachmentPathError(filePath);
  let lexical;
  try {
    lexical = fs.lstatSync(normalizedPath);
  } catch (error) {
    // Preserve the established behavior for a user-selected missing path: the
    // manual handoff may still surface the normal OS error.  Every other
    // metadata failure fails closed rather than becoming an attachment oracle.
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return;
    throw rendererAttachmentPathError(filePath);
  }
  if (!lexical.isFile() || lexical.isSymbolicLink() || Number(lexical.nlink) !== 1) {
    throw rendererAttachmentPathError(filePath);
  }
  let realPath;
  let canonical;
  try {
    realPath = fs.realpathSync.native(normalizedPath);
    canonical = fs.lstatSync(realPath);
  } catch {
    throw rendererAttachmentPathError(filePath);
  }
  if (isRendererSensitivePath(realPath)
    || !canonical.isFile() || canonical.isSymbolicLink() || Number(canonical.nlink) !== 1
    || canonical.dev !== lexical.dev || canonical.ino !== lexical.ino) {
    throw rendererAttachmentPathError(filePath);
  }
}

async function readRendererAttachmentForBridge(filePath) {
  assertRendererAttachmentPathAllowed(filePath);
  const before = await fs.promises.lstat(filePath);
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || Number(opened.nlink) !== 1 || opened.size < 1 || opened.size > 50 * 1024 * 1024) {
      throw rendererAttachmentPathError(filePath);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    assertRendererAttachmentPathAllowed(filePath);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || bytes.length !== opened.size) {
      throw rendererAttachmentPathError(filePath);
    }
    return bytes;
  } finally { await handle.close(); }
}

// Back-compat shim: old call sites passed `signal` as the second positional.
// Detect a plain AbortSignal and wrap it as `{ signal, task: undefined }`.
// New call sites should pass `{ signal, task }`.
function normalizeOpts(opts) {
  if (opts && typeof opts === 'object' && (opts.task !== undefined || opts.signal !== undefined || opts.hints !== undefined || opts.responseSchema !== undefined || opts.cachedPrefix !== undefined || opts.grounding !== undefined || opts.meta !== undefined || opts.retryOnTruncation !== undefined || opts.displayOnlyPromptSuffix !== undefined || opts.responseValidator !== undefined || opts.measureProgressUnits !== undefined || opts.manualHandoff !== undefined || Object.keys(opts).length === 0)) {
    const suppliedManualHandoff = opts.manualHandoff && typeof opts.manualHandoff === 'object'
      ? opts.manualHandoff
      : {};
    const manualHandoff = {
      canStepBack: suppliedManualHandoff.canStepBack === true,
      stepBackLabel: typeof suppliedManualHandoff.stepBackLabel === 'string' ? suppliedManualHandoff.stepBackLabel : '',
      initialResponse: typeof suppliedManualHandoff.initialResponse === 'string' ? suppliedManualHandoff.initialResponse : '',
      comparisonGroup: suppliedManualHandoff.comparisonGroup,
      comparisonRun: suppliedManualHandoff.comparisonRun,
      // Main-process callback only; never materialized into the prompt or IPC.
      onAssigned: typeof suppliedManualHandoff.onAssigned === 'function' ? suppliedManualHandoff.onAssigned : null,
      onRoute: typeof suppliedManualHandoff.onRoute === 'function' ? suppliedManualHandoff.onRoute : null,
    };
    return { signal: opts.signal, task: opts.task, hints: opts.hints || {}, responseSchema: opts.responseSchema, cachedPrefix: opts.cachedPrefix, grounding: !!opts.grounding, displayOnlyPromptSuffix: typeof opts.displayOnlyPromptSuffix === 'string' ? opts.displayOnlyPromptSuffix : '', responseValidator: typeof opts.responseValidator === 'function' ? opts.responseValidator : null, manualHandoff };
  }
  // Anything else (a raw AbortSignal, undefined, etc.) → treat as signal.
  return { signal: opts, task: undefined, hints: {}, responseSchema: undefined, cachedPrefix: undefined, grounding: false, displayOnlyPromptSuffix: '', responseValidator: null, manualHandoff: { canStepBack: false, stepBackLabel: '', initialResponse: '' } };
}

/**
 * Diagnostic snapshot for bug reports: every known task resolves to the
 * single manual transport, unconditionally. Application Generate is
 * diagnosed by the separate Local AI handoff trace.
 */
export function taskModelRoutingSnapshot() {
  const tasks = {};
  for (const task of getKnownTaskIds()) tasks[task] = { transport: NON_API_AI_TRANSPORT };
  return { transport: NON_API_AI_TRANSPORT, tasks };
}
