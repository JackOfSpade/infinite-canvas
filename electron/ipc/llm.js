import { isSensitivePath } from '../utils/pathSafety.js';
import path from 'path';
import { priceSynthesisMaxTokens } from './resultCaps.js';
import { NON_API_AI_TRANSPORT, requestNonApiAi } from './nonApiAi.js';
import { logger } from '../logger.js';

/**
 * Per-task manual-handoff routing.
 *
 * Every AI call the app makes goes through the human copy/paste transport in
 * nonApiAi.js (`requestNonApiAi`): the user is shown a prompt, pastes it into
 * their own chat application, and pastes the reply back. There is exactly one
 * transport — no provider, model, or quality-tier selection happens here.
 * This module tracks the known task ids and each task's output-size guidance
 * (TASK_MAX_TOKENS, written into the copied prompt as a suggested ceiling for
 * the human's chosen chat), and exposes the four typed call shapes
 * (text/raw/vision/document) that the rest of the app calls instead of
 * talking to requestNonApiAi directly.
 */

/**
 * The full set of task ids this router recognizes. Every task shares the one
 * manual transport, so there is nothing to look up per task except its
 * output-size guidance (TASK_MAX_TOKENS below) — this plain set is the
 * single source of truth getKnownTaskIds exposes.
 */
const KNOWN_TASKS = new Set([
  'vision-product-analysis',
  'price-synthesis',
  'bundle-price-synthesis',
  'platform-fit-assessment',
  'marketplace-hub-scan',
  'resume-parse',
  'career-file-extract',
  'job-query-generation',
  'job-scoring',
  'job-taxonomy-plan',
  'job-taxonomy-classify',
  'job-compensation-research',
  'job-compensation-assessment',
  'job-preference-interpretation',
  'job-preference-evaluation',
  'job-preference-research',
  'job-preference-research-assessment',
  'job-role-audit',
  'job-role-screen',
  // The fallback bucket resolveTask() lands on for an unmapped/absent task.
  // It is a real member here so that passing task:'default' explicitly is not
  // itself reported as "unmapped"; getKnownTaskIds() filters it back out
  // because it names no actual call site.
  'default',
]);

/**
 * Per-task output-cap guidance for the manual handoff prompt (the "Maximum
 * output tokens" line materializeNonApiPrompt writes into the copied
 * prompt). Sized to the actual JSON shape each task returns, with headroom —
 * this transport has no cap-raise retry, so a paste that got cut off is a
 * failure the user has to notice and re-paste by hand, not a caught
 * truncation. Better to over-provision than under.
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
  // above the observed 8648-token need); capped at 24576. Formula lives in
  // resultCaps.priceSynthesisMaxTokens so the comp-count ceiling that
  // compsForPricing() feeds is derived from the SAME shape (can't truncate).
  'price-synthesis':           ({ itemCount } = {}) => priceSynthesisMaxTokens(itemCount),
  // Reasoning-heavy models can consume ~1460 thinking + ~50-230 visible
  // tokens for this task — real-world p95 is 1374, max 1510. 2048 sits above
  // the observed max so the cap is adequate on the first attempt (this
  // transport has no cap-raise retry to catch a truncation after the fact).
  'platform-fit-assessment':   2048,  // per-platform fit verdict + short reason
  // Bundle reasoning considers every item even though its visible explanation
  // stays bundle-only. Scale beyond the two-item baseline for thinking headroom.
  'bundle-price-synthesis':    ({ itemCount = 2 } = {}) =>
    Math.min(8192, 2048 + Math.max(0, itemCount - 2) * 350),
  // Hub scan returns an attention list across a whole dashboard/feed — busier
  // than a single listing's check. Scale modestly with the number of hub pages
  // scanned (one consolidated call covers all of a platform's watch URLs).
  'marketplace-hub-scan':      ({ urlCount = 1 } = {}) =>
    Math.min(4096, 1536 + Math.max(0, urlCount - 1) * 512),
  // Full structured profile. Sized off the merged career-data corpus rather than
  // pinned flat: the profile grows with the number of roles, skills and
  // workHistory rows the corpus contains, and a multi-file drop (resume +
  // portfolio + brag doc + a dashboard export) is the designed-for case, not the
  // edge case. A flat 4096 truncated the JSON mid-object on a large corpus, and
  // on the copy/paste transport there is no automatic cap-raise retry to catch
  // it - the person just gets a schema-violation rejection and re-pastes by
  // hand. Caps bill on actual output, so the headroom is free insurance.
  'resume-parse':              ({ promptLength = 0 } = {}) =>
    Math.min(12288, 4096 + Math.floor(promptLength / 4000) * 512),
  // Career-file extract reproduces a whole document as faithful text, so it
  // scales with the source. Sized generously: a truncated transcription
  // silently DROPS the candidate's career history and weakens everything
  // downstream (queries, scoring, the generated résumé). Caps are billed on
  // actual output, so the headroom is free insurance, not a cost.
  'career-file-extract':       16384,
  // Reasoning can consume the same cap as visible output on some models —
  // real-world: thoughts=979, visible=31 at cap=1024 truncated the JSON
  // mid-output. 4096 matches resume-parse and gives ~3000 headroom over
  // typical use (3 short query arrays ≈ 500 tokens visible + ~1000 thinking).
  'job-query-generation':      4096,  // 3 query arrays — small JSON, thinking-heavy
  // Manual scoring returns a bounded decisive-evidence audit (not a complete,
  // duplicated JD transcription). The former 32K cap invited external chats
  // to produce 140K-character pastes for a 15-job batch. This still leaves
  // ample room for four grounded requirements/job while keeping the handoff
  // practical to review and paste.
  'job-scoring':               ({ itemCount = 10 } = {}) =>
    Math.min(12000, 1600 + itemCount * 600),
  // Taxonomy planning is fed only bounded aggregate statistics and returns a
  // tiny role/range/mapping object. Large manual caps made this otherwise
  // mechanical step look like it was hanging.
  'job-taxonomy-plan':         2048,
  // Fallback classification emits only integer role indexes. The planner now
  // handles common directions directly, so this is both rare and compact.
  'job-taxonomy-classify':     () => 1024,
  // One grounded search is shared by a role/seniority/location cohort.
  'job-compensation-research': 4096,
  // Location-based cohort consolidation makes this per-job structured output
  // materially larger than the old city-fragmented cohorts. 12,288 preserves
  // headroom through roughly 17 normal rows before the ceiling applies.
  'job-compensation-assessment': ({ itemCount = 5 } = {}) =>
    Math.min(12288, 2048 + itemCount * 600),
  'job-preference-interpretation': 4096,
  'job-preference-evaluation': ({ itemCount = 10 } = {}) => Math.min(12288, 2048 + itemCount * 800),
  'job-preference-research': 4096,
  'job-preference-research-assessment': 2048,
  // Pass-2 role-resolution audit (JOB_ROLE_AUDIT_SCHEMA, jobPreferences.js's
  // resolveSearchRoles). Visible JSON is small — up to 20 final titles plus
  // up to 20 added/removed titles (worst case ~40 short title strings) and
  // three short prose fields (addedReason/removedReason/rationale, a few
  // hundred chars each) — well under job-preference-interpretation's full
  // plan (up to 24+24 preference items plus this same title list). Matched
  // to that task's cap anyway rather than shaved down: this call runs ONCE
  // per hub (the result is locked and reused verbatim forever after), a
  // reasoning-heavy model auditing two separate checks (coverage/compliance)
  // can spend materially more thinking tokens than the visible JSON implies,
  // and there is no cap-raise retry on this transport — a truncated paste on
  // the one call that matters most is the worst place to be stingy.
  'job-role-audit': 4096,
  // The ONLY high-row-count task here: ROLE_SCREEN_BATCH_SIZE is 200, where
  // every other batched task runs 10-40 rows. It emits one tiny row per job —
  // `{"index":199,"outcome":"mismatch","reason":"registered nurse role"}` is
  // about 20 tokens, and 'match'/'unclear' rows carry an empty reason and cost
  // ~13 — but 200 of them still far exceed the flat 'default' 2048 this task
  // silently fell through to before it was registered here. That truncates the
  // paste, and this transport has NO cap-raise retry, so the whole screen
  // becomes a failed handoff the user has to notice and redo by hand — which
  // would invert the entire point of screening on titles (see
  // screenJobRolesByTitle in jobPreferences.js: the batch is large precisely
  // so one handoff covers the pool). Provisioned at roughly double the
  // all-mismatch worst case; 200 rows → 10624.
  'job-role-screen':           ({ itemCount = 0 } = {}) =>
    Math.min(16384, 1024 + Math.max(0, itemCount) * 48),
  'default':                   2048,
};

function resolveTask(task) {
  if (!task || !KNOWN_TASKS.has(task)) {
    logger.warn(`[LLM] Unmapped task='${task}', using 'default' (2048 max_tokens). Add it to KNOWN_TASKS and TASK_MAX_TOKENS.`);
    return 'default';
  }
  return task;
}

// The set of task ids this router recognizes (KNOWN_TASKS above), minus the
// 'default' fallback — callers enumerate this to report on REAL tasks, and
// 'default' is a safety net rather than something any call site asks for.
export function getKnownTaskIds() {
  return new Set([...KNOWN_TASKS].filter(task => task !== 'default'));
}

/** The calibrated, task-specific token-budget seed written into the manual handoff prompt. */
export function taskMaxTokensFor(task, hints = {}) {
  const t = resolveTask(task);
  const entry = TASK_MAX_TOKENS[t] ?? TASK_MAX_TOKENS['default'];
  return typeof entry === 'function' ? entry(hints) : entry;
}

// Manual job handoffs do not call, select, or fall back between providers —
// there is exactly one transport. Keep only task-local token/schema guidance
// that any chosen chat can follow.
function manualRequestConfig(task, hints = {}, {
  cachedPrefix = null,
  grounding = false,
  requestKind = 'text',
} = {}) {
  // The handoff prompt states a suggested output-token ceiling so the human's
  // chat app has some guidance, but nothing here enforces it: there is no
  // cap-raise retry on this transport, so a truncated paste is a failure the
  // user has to notice and re-paste by hand, not a caught and corrected one.
  const seed = taskMaxTokensFor(resolveTask(task), hints);
  const maxTokens = seed;
  const handoffSettings = {
    requestKind,
    transport: NON_API_AI_TRANSPORT,
    userContent: cachedPrefix
      ? { cachedPrefix: 'inlined before the dynamic prompt above' }
      : { cachedPrefix: null },
    groundingInstruction: grounding
      ? 'Use web research in the chosen chat only when the task prompt requests it.'
      : null,
    generationParameters: 'controlled by the chosen chat application',
  };
  return { maxTokens, formulaSeed: seed, handoffSettings };
}

// Local char→token estimate for the manual verdict below. It is informational
// only — checkPromptFits is always permissive on this transport, nothing is
// gated on this number — so a simple constant-ratio estimate is enough.
const LOCAL_CHARS_PER_TOKEN = 2.5;
function estimateTokensFromChars(chars) {
  return Math.ceil(Math.max(0, Number(chars) || 0) / LOCAL_CHARS_PER_TOKEN);
}

/**
 * Sizing/verdict info for a prompt this task would use. Every AI call is a
 * human copy/paste handoff (requestNonApiAi) — there is no provider context
 * window to preflight against, so this always returns the permissive manual
 * verdict below (`fits: true`, unbounded budget). Kept as its own function,
 * rather than inlined at call sites, because callers still rely on the
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
// TASK_MAX_TOKENS. `signal` is forwarded to the manual handoff so a
// cancelled operation can also cancel a still-pending paste request.

function assertStructuredResponseSchema(responseSchema, caller) {
  if (responseSchema && typeof responseSchema === 'object' && !Array.isArray(responseSchema)) return;
  throw new Error(`${caller} requires a responseSchema. Use callLLMRaw for prose or grounded research.`);
}

/**
 * Structured (JSON-schema) text call — always a manual handoff.
 *
 * `cachedPrefix` — optional static string the caller wants inlined ahead of
 * the dynamic prompt (e.g. job-scoring batches sharing the same profile +
 * rules across calls). On this transport there is no provider-side caching
 * to exploit; it is simply concatenated and noted in the handoff settings so
 * the human can tell it's the same boilerplate across a run.
 */
export async function callLLMText(prompt, opts = {}) {
  const { signal, task, hints, responseSchema, cachedPrefix, retryOnTruncation, responseValidator, manualHandoff } = normalizeOpts(opts);
  assertStructuredResponseSchema(responseSchema, 'callLLMText');
  // Optional by-reference out-param: callers pass `meta: {}` and read back
  // `meta.model` for per-stage telemetry. There is only one transport, so
  // this is always 'non-api-ai', but the out-param contract stays the same
  // shape callers already expect.
  const meta = (opts.meta && typeof opts.meta === 'object') ? opts.meta : null;
  const capHints = { promptLength: (prompt?.length || 0) + (cachedPrefix?.length || 0), ...hints };
  const { maxTokens, formulaSeed, handoffSettings } = manualRequestConfig(task, capHints, {
    cachedPrefix, requestKind: 'structured-text',
  });
  const result = await requestNonApiAi({
    prompt, cachedPrefix, task, responseSchema, maxOutputTokens: maxTokens,
    formulaSeed, handoffSettings, batch: hints.batch, batchTotal: hints.batchTotal, itemCount: hints.itemCount,
    attemptKind: hints.attemptKind, rootBatchSize: hints.rootBatchSize,
    requestKind: 'structured-text', retryOnTruncation, responseValidator, signal,
    canStepBack: manualHandoff.canStepBack,
    stepBackLabel: manualHandoff.stepBackLabel,
    initialResponse: manualHandoff.initialResponse,
  });
  if (meta) meta.model = 'non-api-ai';
  return result;
}

/**
 * Free-text generation — returns the model's raw string (NOT JSON-parsed).
 * Use for prose / HTML / research where a JSON envelope would be wrong.
 *
 * `grounding: true` asks the human's chat application to use its own web
 * research when the task prompt calls for it — this transport has no
 * server-side grounding tool of its own to enable, so it is only ever an
 * instruction inside the copied prompt (see materializeNonApiPrompt).
 */
export async function callLLMRaw(prompt, opts = {}) {
  const { signal, task, hints, grounding, cachedPrefix, manualHandoff } = normalizeOpts(opts);
  const meta = (opts.meta && typeof opts.meta === 'object') ? opts.meta : null;
  const capHints = { promptLength: (prompt?.length || 0) + (cachedPrefix?.length || 0), ...hints };
  const { maxTokens, formulaSeed, handoffSettings } = manualRequestConfig(task, capHints, {
    cachedPrefix, grounding, requestKind: 'raw-text',
  });
  const result = await requestNonApiAi({
    prompt, cachedPrefix, task, grounding, maxOutputTokens: maxTokens,
    formulaSeed, handoffSettings, batch: hints.batch, batchTotal: hints.batchTotal, itemCount: hints.itemCount,
    attemptKind: hints.attemptKind, rootBatchSize: hints.rootBatchSize,
    requestKind: 'raw-text', signal,
    canStepBack: manualHandoff.canStepBack,
    stepBackLabel: manualHandoff.stepBackLabel,
    initialResponse: manualHandoff.initialResponse,
  });
  if (meta) meta.model = 'non-api-ai';
  return result;
}

/** Vision call — image attachments are Finder-revealed for the human to attach to their chat. */
export async function callLLMVision(imagePaths, prompt, opts = {}) {
  // Vision attachments are sourced from the same untrusted canvas JSON as
  // callLLMDocument's filePath below — imagePaths comes from a node's saved
  // state, and a shared/untrusted canvas could point a node at a sensitive
  // system/credential path. Before this session this was enforced inside the
  // per-provider vision call sites themselves, each of which ran an
  // attachment-path safety check over every element of imagePaths before
  // touching the file. Those call sites are gone now that every call routes
  // through the manual handoff, so this is the replacement gate — it must
  // run before any path is Finder-revealed to the user as an attachment to
  // paste into their chat.
  for (const imgPath of (Array.isArray(imagePaths) ? imagePaths : [])) {
    if (isSensitivePath(path.resolve(String(imgPath || '')))) {
      throw new Error(`Refusing to read a sensitive system/credential path as an AI attachment: ${imgPath}`);
    }
  }
  const { signal, task, hints, responseSchema, responseValidator } = normalizeOpts(opts);
  assertStructuredResponseSchema(responseSchema, 'callLLMVision');
  const meta = (opts.meta && typeof opts.meta === 'object') ? opts.meta : null;
  const capHints = { photoCount: imagePaths?.length || 0, promptLength: prompt?.length || 0, ...hints };
  const { maxTokens, formulaSeed, handoffSettings } = manualRequestConfig(task, capHints, {
    requestKind: 'structured-vision',
  });
  const result = await requestNonApiAi({
    prompt, task, responseSchema, maxOutputTokens: maxTokens, formulaSeed,
    handoffSettings, batch: hints.batch, batchTotal: hints.batchTotal, itemCount: hints.itemCount,
    attemptKind: hints.attemptKind, rootBatchSize: hints.rootBatchSize,
    attachmentPaths: imagePaths, requestKind: 'structured-vision', responseValidator, signal,
  });
  if (meta) meta.model = 'non-api-ai';
  return result;
}

export async function callLLMDocument(filePath, prompt, opts = {}) {
  // A document node's filePath is sourced from loaded canvas JSON — an
  // untrusted/shared canvas could point a node at a sensitive system/
  // credential path. Gate here as the single shared entry point before the
  // file is ever Finder-revealed to the user as an attachment.
  if (isSensitivePath(path.resolve(String(filePath || '')))) {
    throw new Error(`Refusing to read a sensitive system/credential path as an AI attachment: ${filePath}`);
  }
  const { signal, task, hints, responseSchema, responseValidator } = normalizeOpts(opts);
  assertStructuredResponseSchema(responseSchema, 'callLLMDocument');
  // The manual handoff does not use a cached prefix for document calls, so
  // none is threaded through here.
  const capHints = { promptLength: prompt?.length || 0, ...hints };
  const { maxTokens, formulaSeed, handoffSettings } = manualRequestConfig(task, capHints, {
    requestKind: 'structured-document',
  });
  return requestNonApiAi({
    prompt, task, responseSchema, maxOutputTokens: maxTokens,
    formulaSeed, handoffSettings, batch: hints.batch, batchTotal: hints.batchTotal, itemCount: hints.itemCount,
    attemptKind: hints.attemptKind, rootBatchSize: hints.rootBatchSize,
    attachmentPaths: [filePath], requestKind: 'structured-document', responseValidator, signal,
  });
}

// Back-compat shim: old call sites passed `signal` as the second positional.
// Detect a plain AbortSignal and wrap it as `{ signal, task: undefined }`.
// New call sites should pass `{ signal, task }`.
function normalizeOpts(opts) {
  if (opts && typeof opts === 'object' && (opts.task !== undefined || opts.signal !== undefined || opts.hints !== undefined || opts.responseSchema !== undefined || opts.cachedPrefix !== undefined || opts.grounding !== undefined || opts.meta !== undefined || opts.retryOnTruncation !== undefined || opts.responseValidator !== undefined || opts.manualHandoff !== undefined || Object.keys(opts).length === 0)) {
    const suppliedManualHandoff = opts.manualHandoff && typeof opts.manualHandoff === 'object'
      ? opts.manualHandoff
      : {};
    const manualHandoff = {
      canStepBack: suppliedManualHandoff.canStepBack === true,
      stepBackLabel: typeof suppliedManualHandoff.stepBackLabel === 'string' ? suppliedManualHandoff.stepBackLabel : '',
      initialResponse: typeof suppliedManualHandoff.initialResponse === 'string' ? suppliedManualHandoff.initialResponse : '',
    };
    return { signal: opts.signal, task: opts.task, hints: opts.hints || {}, responseSchema: opts.responseSchema, cachedPrefix: opts.cachedPrefix, grounding: !!opts.grounding, retryOnTruncation: opts.retryOnTruncation !== false, responseValidator: typeof opts.responseValidator === 'function' ? opts.responseValidator : null, manualHandoff };
  }
  // Anything else (a raw AbortSignal, undefined, etc.) → treat as signal.
  return { signal: opts, task: undefined, hints: {}, responseSchema: undefined, cachedPrefix: undefined, grounding: false, retryOnTruncation: true, responseValidator: null, manualHandoff: { canStepBack: false, stepBackLabel: '', initialResponse: '' } };
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
