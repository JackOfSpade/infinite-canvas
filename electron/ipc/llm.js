import { isSensitivePath } from '../utils/pathSafety.js';
import path from 'path';
import {
  compensationCohortAssessmentMaxTokens,
  jobPreferenceResearchAssessmentMaxTokens,
  jobPreferenceResearchMaxTokens,
  jobScoringMaxTokens,
  listingEvaluationMaxTokens,
  MANUAL_AI_USABLE_OUTPUT_TOKENS,
  marketplaceHubScanBatchMaxTokens,
  priceSynthesisBatchMaxTokens,
  priceSynthesisMaxTokens,
  roleFamilyAssessmentMaxTokens,
} from './resultCaps.js';
import { NON_API_AI_TRANSPORT, durableRunExactStepStatus, durableRunHasExactStep, materializeNonApiPrompt, requestNonApiAi } from './nonApiAi.js';
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
  'price-synthesis-batch',
  'bundle-price-synthesis',
  'platform-fit-assessment',
  'marketplace-hub-scan',
  'marketplace-hub-scan-batch',
  'resume-parse',
  'career-file-extract',
  'job-query-generation',
  'job-scoring',
  'job-taxonomy-plan',
  'job-taxonomy-classify',
  'job-taxonomy-classify-batch',
  'job-compensation-research',
  'job-compensation-assessment',
  'job-compensation-research-batch',
  'job-compensation-assessment-batch',
  'job-preference-interpretation',
  'job-preference-evaluation',
  'job-preference-research',
  'job-preference-research-assessment',
  'job-preference-research-batch',
  'job-preference-research-batch-assessment',
  'job-role-audit',
  'job-role-screen',
  'job-role-screen-batch',
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
  // above the observed 8648-token need). The 24,576 historical formula remains
  // here only so an exact already-issued singleton handoff can be reconstructed;
  // taskMaxTokensFor hard-clamps every fresh request and marketplace.js routes
  // fresh pricing through the <=15,360 v2 batch contract.
  'price-synthesis':           ({ itemCount } = {}) => priceSynthesisMaxTokens(itemCount),
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
  // Hub scan returns an attention list across a whole dashboard/feed — busier
  // than a single listing's check. Scale modestly with the number of hub pages
  // scanned (one consolidated call covers all of a platform's watch URLs).
  'marketplace-hub-scan':      ({ urlCount = 1 } = {}) =>
    Math.min(4096, 1536 + Math.max(0, urlCount - 1) * 512),
  // Combined platform scans are packed by the same conservative estimate in
  // marketplace.js: per-platform JSON/reasoning plus each attached hub page.
  'marketplace-hub-scan-batch': ({ platformCount = 1, urlCount = 1 } = {}) =>
    marketplaceHubScanBatchMaxTokens(platformCount, urlCount),
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
  'career-file-extract':       MANUAL_AI_USABLE_OUTPUT_TOKENS,
  // Reasoning can consume the same cap as visible output on some models —
  // real-world: thoughts=979, visible=31 at cap=1024 truncated the JSON
  // mid-output. 4096 matches resume-parse and gives ~3000 headroom over
  // typical use (3 short query arrays ≈ 500 tokens visible + ~1000 thinking).
  'job-query-generation':      4096,  // 3 query arrays — small JSON, thinking-heavy
  // Manual scoring returns a bounded decisive-evidence audit (not a complete,
  // duplicated JD transcription). Fresh batches contain at most 22 jobs:
  // 1,600 + 22*600 = 14,800, safely below the 15,360 usable output ceiling.
  'job-scoring':               ({ itemCount = 10 } = {}) =>
    jobScoringMaxTokens(itemCount),
  // Taxonomy planning is fed only bounded aggregate statistics and returns a
  // tiny role/range/mapping object. Large manual caps made this otherwise
  // mechanical step look like it was hanging.
  'job-taxonomy-plan':         2048,
  // Fallback classification emits only integer role indexes. The planner now
  // handles common directions directly, so this is both rare and compact.
  'job-taxonomy-classify':     () => 1024,
  // One integer per compact title row. The v2 batcher uses 448 rows, which
  // exactly fills 1,024 + 32*448 = 15,360 without crossing the usable ceiling.
  'job-taxonomy-classify-batch': ({ itemCount = 1 } = {}) =>
    Math.min(MANUAL_AI_USABLE_OUTPUT_TOKENS, 1024 + Math.max(1, itemCount) * 32),
  // One grounded search is shared by a role/seniority/location cohort.
  'job-compensation-research': 4096,
  // Location-based cohort consolidation makes this per-job structured output
  // materially larger than the old city-fragmented cohorts. 12,288 preserves
  // headroom through roughly 17 normal rows before the ceiling applies.
  'job-compensation-assessment': ({ itemCount = 5 } = {}) =>
    Math.min(12288, 2048 + itemCount * 600),
  'job-compensation-research-batch': ({ roleFamilyCount = 0, cohortCount = 0, itemCount = 1 } = {}) => {
    const roles = Math.max(0, Number(roleFamilyCount) || 0);
    const cohorts = Math.max(0, Number(cohortCount) || 0);
    return Math.min(MANUAL_AI_USABLE_OUTPUT_TOKENS,
      2048 + (roles > 0 ? roles * 1800 : Math.max(1, cohorts || itemCount) * 3000));
  },
  'job-compensation-assessment-batch': ({ roleFamilyCount = 0, cohortCount = 0, itemCount = 1 } = {}) => {
    const roles = Math.max(0, Number(roleFamilyCount) || 0);
    const cohorts = Math.max(0, Number(cohortCount) || 0);
    const rows = Math.max(1, Number(itemCount) || 1);
    return Math.min(MANUAL_AI_USABLE_OUTPUT_TOKENS,
      roles > 0 ? roleFamilyAssessmentMaxTokens(roles) : compensationCohortAssessmentMaxTokens(Math.max(1, cohorts), rows));
  },
  'job-preference-interpretation': 4096,
  // Output volume here is listings × preference-plan items — the model writes
  // one match object per pair — so the cap is keyed on that PRODUCT, not on the
  // listing count. resultCaps owns the constants so this cap and the batch size
  // that feeds it are derived from the same numbers. The itemCount fallback
  // assumes an 8-item plan for callers that don't supply matchCount.
  // `observedTokensPerMatch` rides in on the hints so the DECLARED budget uses
  // the same measured cost model the batch size was chosen with. When they
  // disagreed, a verbose model correctly shrank the batch while the prompt
  // still quoted the old static budget — telling the model to write less than
  // the answer it was being asked for actually needs.
  'job-preference-evaluation': ({ matchCount, itemCount = 10, observedTokensPerMatch = null } = {}) =>
    listingEvaluationMaxTokens(
      Number.isFinite(matchCount) ? matchCount : itemCount * 8,
      itemCount,
      { observedTokensPerMatch },
    ),
  'job-preference-research': 4096,
  'job-preference-research-assessment': 2048,
  // A single employer research result was intentionally small enough for the
  // former one-company handoff. Batched research must instead scale its
  // declared manual-chat ceiling with the number of employers it contains.
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
  // can spend materially more thinking tokens than the visible JSON implies,
  // and there is no cap-raise retry on this transport — a truncated paste on
  // the one call that matters most is the worst place to be stingy.
  'job-role-audit': 4096,
  // The ONLY high-row-count task here. Durable v1 `job-role-screen` prompts
  // keep their original 200-row layout and may use the historical hard cap;
  // fresh `job-role-screen-batch` prompts pack up to 298 rows beneath the
  // shared 15,360-token usable ceiling. Each emits one tiny row per job —
  // `{"index":199,"outcome":"mismatch","reason":"registered nurse role"}` is
  // about 20 tokens, and 'match'/'unclear' rows carry an empty reason and cost
  // ~13 — but 200 of them still far exceed the flat 'default' 2048 this task
  // silently fell through to before it was registered here. That truncates the
  // paste, and this transport has NO cap-raise retry, so the whole screen
  // becomes a failed handoff the user has to notice and redo by hand — which
  // would invert the entire point of screening on titles (see
  // screenJobRolesByTitle in jobPreferences.js: the batch is large precisely
  // so one handoff covers the pool). Provisioned at roughly double the
  // all-mismatch worst case; 200 rows → 10,624 and 298 rows → 15,328.
  'job-role-screen':           ({ itemCount = 0 } = {}) =>
    Math.min(16384, 1024 + Math.max(0, itemCount) * 48),
  'job-role-screen-batch':     ({ itemCount = 0 } = {}) =>
    Math.min(MANUAL_AI_USABLE_OUTPUT_TOKENS, 1024 + Math.max(0, itemCount) * 48),
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
  // The handoff is manually pasted into a chat app, but its requested output
  // must still fit the transport's real 16,384-token ceiling. New packed
  // workflows target the more conservative 15,360 usable budget themselves.
  return Math.min(16384, typeof entry === 'function' ? entry(hints) : entry);
}

// Manual job handoffs do not call, select, or fall back between providers —
// there is exactly one transport. Keep only task-local token/schema guidance
// that any chosen chat can follow.
function manualRequestConfig(task, hints = {}, {
  cachedPrefix = null,
  grounding = false,
  requestKind = 'text',
  // Narrow migration escape hatch: the retired one-item price prompt had
  // durable keys materialized with its historical 24,576 seed. It is allowed
  // only while replaying an exact existing step; fresh work must use the v2
  // packed price-synthesis-batch contract and its 15,360 ceiling.
  exactLegacyPriceSynthesisHandoff = false,
} = {}) {
  // The handoff prompt states a suggested output-token ceiling so the human's
  // chat app has some guidance, but nothing here enforces it: there is no
  // cap-raise retry on this transport, so a truncated paste is a failure the
  // user has to notice and re-paste by hand, not a caught and corrected one.
  const resolvedTask = resolveTask(task);
  const seed = exactLegacyPriceSynthesisHandoff === true && resolvedTask === 'price-synthesis'
    ? priceSynthesisMaxTokens(hints.itemCount)
    : taskMaxTokensFor(resolvedTask, hints);
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
  const { signal, task, hints, responseSchema, cachedPrefix, retryOnTruncation, displayOnlyPromptSuffix, responseValidator, legacyReplay, manualHandoff } = normalizeOpts(opts);
  assertStructuredResponseSchema(responseSchema, 'callLLMText');
  // Optional by-reference out-param: callers pass `meta: {}` and read back
  // `meta.model` for per-stage telemetry. There is only one transport, so
  // this is always 'non-api-ai', but the out-param contract stays the same
  // shape callers already expect.
  const meta = (opts.meta && typeof opts.meta === 'object') ? opts.meta : null;
  const capHints = { promptLength: (prompt?.length || 0) + (cachedPrefix?.length || 0), ...hints };
  const { maxTokens, formulaSeed, handoffSettings } = manualRequestConfig(task, capHints, {
    cachedPrefix, requestKind: 'structured-text',
    exactLegacyPriceSynthesisHandoff: opts?.exactLegacyPriceSynthesisHandoff === true,
  });
  const result = await requestNonApiAi({
    prompt, cachedPrefix, task, responseSchema, maxOutputTokens: maxTokens,
    formulaSeed, handoffSettings, batch: hints.batch, batchTotal: hints.batchTotal, itemCount: hints.itemCount,
    itemsDone: hints.itemsDone, itemsTotal: hints.itemsTotal, planItemCount: hints.planItemCount, matchCount: hints.matchCount,
    progressScopeId: hints.progressScopeId, progressUnitId: hints.progressUnitId, progressUnits: hints.progressUnits,
    queuedWorkForecast: hints.queuedWorkForecast,
    attemptKind: hints.attemptKind, rootBatchSize: hints.rootBatchSize,
    requestKind: 'structured-text', retryOnTruncation, displayOnlyPromptSuffix, responseValidator, legacyReplay,
    measureResponseUnits: opts?.measureResponseUnits, measureProgressUnits: opts?.measureProgressUnits, signal,
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
  const {
    signal,
    task,
    hints,
    grounding,
    cachedPrefix,
    retryOnTruncation,
    displayOnlyPromptSuffix,
    responseValidator,
    manualHandoff,
  } = normalizeOpts(opts);
  const meta = (opts.meta && typeof opts.meta === 'object') ? opts.meta : null;
  const capHints = { promptLength: (prompt?.length || 0) + (cachedPrefix?.length || 0), ...hints };
  const { maxTokens, formulaSeed, handoffSettings } = manualRequestConfig(task, capHints, {
    cachedPrefix, grounding, requestKind: 'raw-text',
  });
  const result = await requestNonApiAi({
    prompt, cachedPrefix, task, grounding, maxOutputTokens: maxTokens,
    formulaSeed, handoffSettings, batch: hints.batch, batchTotal: hints.batchTotal, itemCount: hints.itemCount,
    itemsDone: hints.itemsDone, itemsTotal: hints.itemsTotal, planItemCount: hints.planItemCount, matchCount: hints.matchCount,
    progressScopeId: hints.progressScopeId, progressUnitId: hints.progressUnitId, progressUnits: hints.progressUnits,
    queuedWorkForecast: hints.queuedWorkForecast,
    attemptKind: hints.attemptKind, rootBatchSize: hints.rootBatchSize,
    requestKind: 'raw-text', retryOnTruncation, displayOnlyPromptSuffix, responseValidator,
    measureProgressUnits: opts?.measureProgressUnits, signal,
    canStepBack: manualHandoff.canStepBack,
    stepBackLabel: manualHandoff.stepBackLabel,
    initialResponse: manualHandoff.initialResponse,
  });
  if (meta) meta.model = 'non-api-ai';
  return result;
}

/**
 * Ask whether this exact raw-text request already owns a durable handoff.
 *
 * This mirrors callLLMRaw's pre-code materialization rather than looking at
 * task labels. It is intentionally read-only and exists for narrow contract
 * migrations: an old request in a partially completed run can keep its old
 * prompt, while fresh siblings move to a newer packed prompt.
 */
export async function hasExactDurableRawHandoff(prompt, {
  manualAiRunId,
  nodeId = null,
  ...opts
} = {}) {
  return (await exactDurableRawHandoffStatus(prompt, {
    manualAiRunId,
    nodeId,
    ...opts,
  })) !== null;
}

/**
 * Exact raw handoff status for stable durable scheduling. `accepted` can be
 * replayed before the live worker roster; `pending` keeps its planned identity.
 */
export async function exactDurableRawHandoffStatus(prompt, {
  manualAiRunId,
  nodeId = null,
  ...opts
} = {}) {
  const { task, hints, grounding, cachedPrefix, retryOnTruncation } = normalizeOpts(opts);
  const capHints = { promptLength: (prompt?.length || 0) + (cachedPrefix?.length || 0), ...hints };
  const { maxTokens, formulaSeed, handoffSettings } = manualRequestConfig(task, capHints, {
    cachedPrefix, grounding, requestKind: 'raw-text',
  });
  const materializedPrompt = materializeNonApiPrompt({
    prompt,
    cachedPrefix,
    task,
    grounding,
    maxOutputTokens: maxTokens,
    formulaSeed,
    requestKind: 'raw-text',
    retryOnTruncation,
    handoffSettings,
    // requestNonApiAi hashes this exact pre-code, non-hardened form.
    hardenTaskPrompt: false,
    includeStrictJsonSerializationCheck: false,
  });
  return durableRunExactStepStatus(manualAiRunId, {
    materializedPrompt,
    task,
    nodeId,
    batch: hints.batch,
    batchTotal: hints.batchTotal,
    itemCount: hints.itemCount,
  });
}

/** Read-only exact-step counterpart for callLLMText. */
export async function hasExactDurableTextHandoff(prompt, {
  manualAiRunId,
  nodeId = null,
  ...opts
} = {}) {
  const { task, hints, responseSchema, cachedPrefix, retryOnTruncation } = normalizeOpts(opts);
  assertStructuredResponseSchema(responseSchema, 'hasExactDurableTextHandoff');
  const capHints = { promptLength: (prompt?.length || 0) + (cachedPrefix?.length || 0), ...hints };
  const { maxTokens, formulaSeed, handoffSettings } = manualRequestConfig(task, capHints, {
    cachedPrefix, requestKind: 'structured-text',
    exactLegacyPriceSynthesisHandoff: opts?.exactLegacyPriceSynthesisHandoff === true,
  });
  const materializedPrompt = materializeNonApiPrompt({
    prompt,
    cachedPrefix,
    task,
    responseSchema,
    maxOutputTokens: maxTokens,
    formulaSeed,
    requestKind: 'structured-text',
    retryOnTruncation,
    handoffSettings,
    hardenTaskPrompt: false,
    includeStrictJsonSerializationCheck: false,
  });
  return durableRunHasExactStep(manualAiRunId, {
    materializedPrompt,
    task,
    nodeId,
    batch: hints.batch,
    batchTotal: hints.batchTotal,
    itemCount: hints.itemCount,
  });
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
  // Immutable recovery staging may replace the attachment path after hashing;
  // continue applying the sensitive-path policy to the original user-selected
  // source paths supplied by that trusted staging caller.
  const attachmentSafetyPaths = Array.isArray(opts?.attachmentSourcePaths)
    ? opts.attachmentSourcePaths
    : imagePaths;
  for (const imgPath of (Array.isArray(attachmentSafetyPaths) ? attachmentSafetyPaths : [])) {
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
    itemsDone: hints.itemsDone, itemsTotal: hints.itemsTotal, planItemCount: hints.planItemCount, matchCount: hints.matchCount,
    progressScopeId: hints.progressScopeId, progressUnitId: hints.progressUnitId, progressUnits: hints.progressUnits,
    attemptKind: hints.attemptKind, rootBatchSize: hints.rootBatchSize,
    attachmentPaths: imagePaths, requestKind: 'structured-vision', responseValidator,
    measureProgressUnits: opts?.measureProgressUnits, signal,
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
    itemsDone: hints.itemsDone, itemsTotal: hints.itemsTotal, planItemCount: hints.planItemCount, matchCount: hints.matchCount,
    progressScopeId: hints.progressScopeId, progressUnitId: hints.progressUnitId, progressUnits: hints.progressUnits,
    attemptKind: hints.attemptKind, rootBatchSize: hints.rootBatchSize,
    attachmentPaths: [filePath], requestKind: 'structured-document', responseValidator,
    measureProgressUnits: opts?.measureProgressUnits, signal,
  });
}

// Back-compat shim: old call sites passed `signal` as the second positional.
// Detect a plain AbortSignal and wrap it as `{ signal, task: undefined }`.
// New call sites should pass `{ signal, task }`.
function normalizeOpts(opts) {
  if (opts && typeof opts === 'object' && (opts.task !== undefined || opts.signal !== undefined || opts.hints !== undefined || opts.responseSchema !== undefined || opts.cachedPrefix !== undefined || opts.grounding !== undefined || opts.meta !== undefined || opts.retryOnTruncation !== undefined || opts.displayOnlyPromptSuffix !== undefined || opts.responseValidator !== undefined || opts.measureProgressUnits !== undefined || opts.legacyReplay !== undefined || opts.manualHandoff !== undefined || Object.keys(opts).length === 0)) {
    const suppliedManualHandoff = opts.manualHandoff && typeof opts.manualHandoff === 'object'
      ? opts.manualHandoff
      : {};
    const manualHandoff = {
      canStepBack: suppliedManualHandoff.canStepBack === true,
      stepBackLabel: typeof suppliedManualHandoff.stepBackLabel === 'string' ? suppliedManualHandoff.stepBackLabel : '',
      initialResponse: typeof suppliedManualHandoff.initialResponse === 'string' ? suppliedManualHandoff.initialResponse : '',
    };
    const legacyReplay = opts.legacyReplay && typeof opts.legacyReplay === 'object'
      && typeof opts.legacyReplay.prompt === 'string'
      && opts.legacyReplay.responseSchema && typeof opts.legacyReplay.responseSchema === 'object'
      && !Array.isArray(opts.legacyReplay.responseSchema)
      && typeof opts.legacyReplay.responseValidator === 'function'
      ? opts.legacyReplay
      : null;
    return { signal: opts.signal, task: opts.task, hints: opts.hints || {}, responseSchema: opts.responseSchema, cachedPrefix: opts.cachedPrefix, grounding: !!opts.grounding, retryOnTruncation: opts.retryOnTruncation !== false, displayOnlyPromptSuffix: typeof opts.displayOnlyPromptSuffix === 'string' ? opts.displayOnlyPromptSuffix : '', responseValidator: typeof opts.responseValidator === 'function' ? opts.responseValidator : null, legacyReplay, manualHandoff };
  }
  // Anything else (a raw AbortSignal, undefined, etc.) → treat as signal.
  return { signal: opts, task: undefined, hints: {}, responseSchema: undefined, cachedPrefix: undefined, grounding: false, retryOnTruncation: true, displayOnlyPromptSuffix: '', responseValidator: null, legacyReplay: null, manualHandoff: { canStepBack: false, stepBackLabel: '', initialResponse: '' } };
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
