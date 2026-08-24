import { getAISettings } from './settings.js';
import { callGeminiText, callGeminiTextRaw, callGeminiVision, callGeminiDocument, countGeminiInputTokens } from './gemini.js';
import { GEMINI_ALL_MODEL_IDS, GEMINI_MAX_OUTPUT_TOKENS } from './geminiModels.js';
import { callClaudeText, callClaudeVision, callClaudeDocument, getClaudeBatch, getClaudeBatchResults, cancelClaudeBatch, countClaudeInputTokens } from './claude.js';
import { parseAiJson } from './jsonRepair.js';
import { isWordDoc, extractWordText } from './docUtils.js';
import { isSensitivePath } from '../utils/pathSafety.js';
import { effectiveCap } from './tokenBudget.js';
import path from 'path';
import { priceSynthesisMaxTokens } from './resultCaps.js';
import { modelMeta, maxOutputForModel, assessPromptFit, estimateTokensFromChars } from './tokenWindow.js';
import { claudeReasoningMaxTokens } from './claudeModels.js';
import { CLAUDE_FAMILY, isClaudeFamilyToken, claudeModelFor, resolvedClaudeModels, primeClaudeModels } from './modelResolver.js';
import { handleSafe } from './ipcUtils.js';
import { logger } from '../logger.js';

/**
 * Per-task model selection.
 *
 * Each call site declares its `task` and this layer picks the right model
 * for the active provider. Quality+cost decisions belong with whoever wrote
 * the prompt, not with the user, who has no signal about which task needs
 * which QUALITY TIER — but the user DOES get a say in what each tier actually
 * costs (see "Task groups" below). Within Claude, the tier-to-family mapping
 * (Opus vs Sonnet vs Haiku vs Fable) is a Settings choice, not a hard-code.
 *
 * The Gemini column below (TASK_MODELS) stays literal, per-task, and is NOT
 * user-selectable — the Gemini path is a capability-ladder CASCADE (pro →
 * flash → lite, geminiModels.js) that self-upgrades/downgrades per call
 * based on live entitlement + 429s, so there's no single "the model" to
 * expose a picker for the way Claude has one resolved id per family.
 *
 * Gemini choices, in short:
 *   - Gemini 3.7 Flash: preferred for Sonnet/Opus-quality tasks on the API-key
 *     path — the newest Flash generation. It is the HEAD of a cascade, not the
 *     only model: callGemini walks the capability ladder (pro → flash → lite)
 *     from here, and whether the Pro tier is available is decided by a live
 *     entitlement probe per credential rather than a hard-coded exclusion (see
 *     geminiEntitlement.js). On a free-tier key Pro reports `limit: 0` and stays
 *     out; on a billing-enabled key it joins the head of the chain with no code
 *     change.
 *   - Gemini 3.5 Flash-Lite: matches the `light` group's tasks — the newest
 *     Lite generation. Lite-preferred tasks deliberately never climb to Pro:
 *     the author chose the cheap tier on purpose.
 */
const TASK_MODELS = {
  'vision-product-analysis':   { gemini: 'gemini-3.7-flash' },
  'price-synthesis':           { gemini: 'gemini-3.7-flash' },
  // Bundle pricing is a pricing JUDGMENT (synergy reasoning across items), so it
  // gets the same tier as price-synthesis — not the cheaper `light` tier used
  // for mechanical classification (per the quality-over-cost preference on
  // pricing).
  'bundle-price-synthesis':    { gemini: 'gemini-3.7-flash' },
  'platform-fit-assessment':   { gemini: 'gemini-3.5-flash-lite' },
  'page-status-classify':      { gemini: 'gemini-3.5-flash-lite' },
  // Marketplace Status Module hub scan — mechanical extraction of action items
  // from a seller dashboard / notification feed, same tier as page-status-classify
  // (scanning, not pricing judgment, so `light` per the quality-over-cost split).
  'marketplace-hub-scan':      { gemini: 'gemini-3.5-flash-lite' },
  'resume-parse':              { gemini: 'gemini-3.7-flash' },
  'career-file-extract':       { gemini: 'gemini-3.7-flash' },
  'job-query-generation':      { gemini: 'gemini-3.7-flash' },
  'job-scoring':                { gemini: 'gemini-3.7-flash' },
  'job-bucketing':              { gemini: 'gemini-3.7-flash' },
  // Two-step cash-compensation pipeline: grounded research discovers current
  // market evidence; a separate structured pass extracts comparable ranges.
  'job-compensation-research':  { gemini: 'gemini-3.7-flash' },
  'job-compensation-assessment': { gemini: 'gemini-3.7-flash' },
  'text-polish':               { gemini: 'gemini-3.5-flash-lite' },
  // Default — used when a caller forgets to pass `task`. Logged as a warning
  // below so we notice unmapped sites; tuned to a safe-middle.
  'default':                   { gemini: 'gemini-3.7-flash' },
};

/**
 * ── Task groups: the user-selected Claude tier ─────────────────────────────
 *
 * On the Claude path, every task belongs to exactly one live API group.
 * `analysis` and `light` take their family from Settings (`ai.claudeModels`),
 * with GROUP_DEFAULT_FAMILY as the safe fallback for absent or invalid values.
 */
const GROUP_DEFAULT_FAMILY = {
  analysis:   CLAUDE_FAMILY.SONNET,
  light:      CLAUDE_FAMILY.HAIKU,
};

const TASK_GROUPS = {
  // analysis — vision identification, pricing judgment, resume parsing, job
  // scoring/query-gen/bucketing, and the fallback default: anywhere quality
  // compounds or the output is user-facing rather than a light classifier.
  // Query gen and bucketing are here deliberately: query quality
  // gates which jobs are ever DISCOVERED, and the bucketing role-
  // consolidation IS the user-facing results hierarchy. Both run once per
  // search (not per-job), so the quality tier is cheap regardless of pick.
  'vision-product-analysis':   { group: 'analysis' },
  'price-synthesis':           { group: 'analysis' },
  'bundle-price-synthesis':    { group: 'analysis' },
  'resume-parse':              { group: 'analysis' },
  'career-file-extract':       { group: 'analysis' },
  'job-query-generation':      { group: 'analysis' },
  'job-scoring':                { group: 'analysis' },
  'job-bucketing':              { group: 'analysis' },
  'job-compensation-research':  { group: 'analysis' },
  'job-compensation-assessment': { group: 'analysis' },
  'default':                    { group: 'analysis' },

  // light — page status classify, text polish, platform-fit: short
  // structured outputs (enum + a sentence) where a bigger family adds no
  // real quality.
  'platform-fit-assessment':   { group: 'light' },
  'page-status-classify':      { group: 'light' },
  'marketplace-hub-scan':      { group: 'light' },
  'text-polish':                { group: 'light' },
};

// Invariant: TASK_MODELS and TASK_GROUPS must cover exactly the same task
// set. A task present in one but not the other would silently fall through
// to 'default' in only ONE of the two model-selection dimensions (provider-
// specific id vs. Claude group/tier) — far harder to notice than a boot-time
// crash, so fail loud instead.
{
  const modelKeys = new Set(Object.keys(TASK_MODELS));
  const groupKeys = new Set(Object.keys(TASK_GROUPS));
  for (const k of modelKeys) {
    if (!groupKeys.has(k)) throw new Error(`[LLM] Task '${k}' has a TASK_MODELS entry but no TASK_GROUPS entry.`);
  }
  for (const k of groupKeys) {
    if (!modelKeys.has(k)) throw new Error(`[LLM] Task '${k}' has a TASK_GROUPS entry but no TASK_MODELS entry.`);
  }
}

/**
 * Per-task output cap. The old code hardcoded 8192 everywhere — fine on
 * Anthropic (billed on actual output) but bloats Vertex provisioning and
 * leaks no useful information. Sized to the actual JSON shape each task
 * returns, with headroom.
 *
 * A value may be a number (static cap) OR a function `(hints) => number`
 * that scales with input characteristics. Hints currently supported:
 *   - photoCount: number of images in a vision call
 *   - promptLength: chars in the text prompt
 *   - itemCount: e.g. number of jobs to score in one call
 *
 * Dynamic sizing only works because output truncation IS still billed (you
 * pay for the tokens the model produced before being cut off), so retries
 * on MAX_TOKENS are strictly more expensive than sizing the cap right
 * upfront. Heuristics give us "as small as is safe" without the retry cost.
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
  // about each item individually. Real-world calibration:
  //   - preferred Flash-tier Gemini: 90 comps → ~7861 thinking + ~317 visible
  //   - older fallback Gemini: 40 comps → ~8048 thinking + ~317 visible
  //     (truncated at 8383; formula seed was 7000 — the formula was the bug).
  // The heavier fallback used ~200 tok/comp vs ~87 for the preferred model.
  // Formula must
  // accommodate the fallback chain: ~200 thinking/comp + ~600 visible budget.
  // 40 items → 11000 (above the 8648 observed need + headroom); capped at 24576.
  // Formula lives in resultCaps.priceSynthesisMaxTokens so the comp-count ceiling
  // that compsForPricing() feeds is derived from the SAME shape (can't truncate).
  'price-synthesis':           ({ itemCount } = {}) => priceSynthesisMaxTokens(itemCount),
  // Thinking-heavy fallback models consume
  // ~1460 thinking + ~50–230 visible tokens for this task — real-world p95 is
  // 1374, max 1510. The old 1024 seed forced self-calibration to catch up over
  // truncation cycles. 2048 is above the observed max so the cap is adequate
  // even on a fresh install with no learned state.
  'platform-fit-assessment':   2048,  // per-platform fit verdict + short reason
  // Bundle reasoning considers every item even though its visible explanation
  // stays bundle-only. Scale beyond the two-item baseline for thinking headroom.
  'bundle-price-synthesis':    ({ itemCount = 2 } = {}) =>
    Math.min(8192, 2048 + Math.max(0, itemCount - 2) * 350),
  'page-status-classify':      512,   // 5-way enum + one sentence
  // Hub scan returns an attention list across a whole dashboard/feed — busier
  // than a single listing's check. Scale modestly with the number of hub pages
  // scanned (one consolidated call covers all of a platform's watch URLs).
  'marketplace-hub-scan':      ({ urlCount = 1 } = {}) =>
    Math.min(4096, 1536 + Math.max(0, urlCount - 1) * 512),
  'resume-parse':              4096,  // full structured profile
  // Career-file extract reproduces a whole document as faithful text, so it
  // scales with the source. Sized generously: a truncated transcription
  // silently DROPS the candidate's career history and weakens everything
  // downstream (queries, scoring, the generated résumé). Caps are billed on
  // actual output, so the headroom is free insurance, not a cost.
  'career-file-extract':       16384,
  // The active Flash-tier Gemini engages thinking which eats the same cap as
  // visible output — real-world: thoughts=979, visible=31 at cap=1024 truncated
  // the JSON mid-output. 4096 matches resume-parse and gives ~3000 headroom over
  // typical use (3 short query arrays ≈ 500 tokens visible + ~1000 thinking).
  'job-query-generation':      4096,  // 3 query arrays — small JSON, thinking-heavy
  // Job scoring now emits a requirement-by-requirement evidence inventory,
  // material gaps, and separate tenure assessments in addition to the concise
  // fit explanation. On thinking-capable models, the former 420/item reserve
  // could truncate that structured evidence before the final rows. Formula:
  // 2800 base + 1000/item gives 15→17800, still capped at 24576 so a
  // pathological batch cannot request runaway billing. Output is billed on
  // actual tokens; the reserve is headroom for complete, auditable JSON.
  'job-scoring':               ({ itemCount = 10 } = {}) =>
    Math.min(24576, 2800 + itemCount * 1000),
  // Bucketing reasons over salaries per category — thinking-heavy (the model
  // weighs each job's salary against its category's distribution). The old
  // static 6144 was calibrated against an older lighter-thinking Flash model
  // and an over-optimistic "~500 visible" estimate; on newer thinking-heavy
  // models it truncated — real telemetry on a 15-job run: gemini-3.5-flash emitted
  // 3229 thinking + 2899 visible (=6128) and was STILL cut off at 6144, only
  // surviving because the dynamic fallback reached a model that didn't think.
  // Both thinking and visible scale ~linearly with job count (one jobIndex per
  // job in the output, ~215 thinking + ~195 visible per job observed), so size
  // it per-item like job-scoring. 4096 base + 400/item gives 15→10k (~1.6x the
  // observed truncation point), 50→24k, capped at 24576 to bound billing.
  'job-bucketing':             ({ itemCount = 15 } = {}) =>
    Math.min(24576, 4096 + itemCount * 400),
  // One grounded search is shared by a role/seniority/location cohort.
  'job-compensation-research': 4096,
  'job-compensation-assessment': ({ itemCount = 5 } = {}) =>
    Math.min(8192, 2048 + itemCount * 600),
  'text-polish':               1024,  // light edit
  'default':                   2048,
};

function resolveTask(task) {
  if (!task || !TASK_MODELS[task]) {
    logger.warn(`[LLM] Unmapped task='${task}', using 'default' (analysis group / Gemini 3.7 Flash, 2048 max_tokens). Add it to TASK_MODELS and TASK_GROUPS.`);
    return 'default';
  }
  return task;
}

// The set of task ids registered in the live routing + token-cap tables (union
// of both maps, minus the 'default' fallback).
export function getKnownTaskIds() {
  return new Set(
    [...Object.keys(TASK_MODELS), ...Object.keys(TASK_MAX_TOKENS)].filter(k => k !== 'default')
  );
}

/**
 * The Claude FAMILY that serves `task` on the Claude provider: the task's
 * group's user-selected family (settings.claudeModels[group]).
 *
 * Falls back to GROUP_DEFAULT_FAMILY when `settings.claudeModels` is absent
 * (an older persisted config) or carries an unrecognized token. settings.js's
 * getAISettings() already normalizes this on read, but claudeFamilyForTask is
 * also reachable with a hand-built `settings` object (tests, or a future
 * caller that never went through that layer), so it re-validates rather than
 * trusting the shape blindly.
 */
function claudeFamilyForTask(task, settings) {
  const t = resolveTask(task);
  const { group } = TASK_GROUPS[t];
  const configured = settings?.claudeModels?.[group];
  return isClaudeFamilyToken(configured) ? configured : GROUP_DEFAULT_FAMILY[group];
}

function pickModel(provider, task, settings) {
  const t = resolveTask(task);
  if (provider === 'claude') return claudeModelFor(claudeFamilyForTask(t, settings), settings?.anthropicApiKey);
  return TASK_MODELS[t].gemini || TASK_MODELS['default'].gemini;
}

/**
 * Which API provider serves `task` — purely the user's Settings choice.
 *
 * Generic LLM calls support Gemini API and Claude API only. `task` is kept in
 * the signature for API stability (every call site already threads it through)
 * even though the provider selection does not depend on it.
 *
 * PURE — no throw, no network.
 */
export function providerForTask(task, settings = getAISettings()) {
  return settings?.provider === 'claude' ? 'claude' : 'gemini';
}

/**
 * The model id that will actually serve `task` — the same choice
 * checkPromptFits / callLLMText make, exposed so a caller can size work to
 * that model BEFORE the call (e.g. jobScoringBatchSize). Returns the PRIMARY
 * model; a Gemini cascade may use any compatible fallback, but those share the
 * window/output limits the sizing depends on.
 */
export function modelForTask(task, settings = getAISettings()) {
  return pickModel(providerForTask(task, settings), task, settings);
}

/**
 * Diagnostic snapshot for bug reports: how every registered live API task
 * resolves by GROUP and individual TASK, given the active provider and the
 * user's `claudeModels` picks. Application Generate is diagnosed by the
 * separate Local AI handoff trace.
 */
export function taskModelRoutingSnapshot(settings = getAISettings()) {
  const provider = providerForTask(undefined, settings); // task-independent — see providerForTask doc
  const tasksForReport = getKnownTaskIds();
  const groups = {};
  for (const group of Object.keys(GROUP_DEFAULT_FAMILY)) {
    const configured = settings?.claudeModels?.[group];
    const family = isClaudeFamilyToken(configured) ? configured : GROUP_DEFAULT_FAMILY[group];
    groups[group] = { family, model: claudeModelFor(family, settings?.anthropicApiKey) };
  }
  const tasks = {};
  for (const task of tasksForReport) {
    const { group } = TASK_GROUPS[task];
    tasks[task] = { group, provider, model: pickModel(provider, task, settings) };
  }
  return { provider, groups, tasks };
}

function pickMaxTokens(task, hints = {}, provider = null, model = null) {
  const t = resolveTask(task);
  const entry = TASK_MAX_TOKENS[t] ?? TASK_MAX_TOKENS['default'];
  const seed = typeof entry === 'function' ? entry(hints) : entry;
  // The TASK_MAX_TOKENS value above is the calibrated seed/floor. effectiveCap
  // raises it toward observed p95 usage if a model has churned to use more than
  // the formula assumed (never below the seed; never above the 24576 hard cap).
  const learnedCap = effectiveCap(t, seed);
  // Legacy Claude models use a fixed extended-thinking budget rather than
  // adaptive effort. Reserve its required reasoning + answer headroom before
  // every caller and every preflight, so the request shape and context math
  // cannot disagree. Modern Claude and Gemini retain their calibrated caps.
  const cap = provider === 'claude' && model
    ? claudeReasoningMaxTokens(model, learnedCap)
    : provider === 'gemini'
      ? Math.max(learnedCap, GEMINI_MAX_OUTPUT_TOKENS)
      : learnedCap;
  return { cap, seed };
}

/**
 * After a provider failed with an output-cap truncation, the cap that would be
 * used NOW — or null if there is nothing to gain from trying again.
 *
 * The provider records the truncation SYNCHRONOUSLY before it throws
 * (recordTruncation, claude.js/gemini.js), which raises this task's persisted
 * floor immediately; the call that paid for the truncation is the only one that
 * never gets to use it. Re-resolving here recovers the corrected cap for a
 * single retry — the difference between a completed atomic call and a hard
 * failure for non-chunkable tasks such as career-file extraction.
 *
 * Returns null unless the floor ACTUALLY moved, so a task already pinned at
 * TOKEN_HARD_CAP (or one that failed for any other reason) never retries.
 * `err.code` is the real signal; the message match is a fallback for any
 * provider path that loses the tag on its way up (e.g. a wrapped cascade error).
 */
function raisedCapAfterTruncation(err, { signal, usedCap, task, hints, provider, model }) {
  if (signal?.aborted) return null;
  const truncated = err?.code === 'MAX_TOKENS' || /hit the \d+-token output cap/.test(err?.message || '');
  if (!truncated) return null;
  const resolved = pickMaxTokens(task, hints, provider, model);
  return resolved.cap > usedCap ? resolved : null;
}

// ── Context-window preflight ──────────────────────────────────────────────────
/**
 * Will `prompt` (+ its cached prefix and the task's reserved output) fit the
 * context window of the model that will actually serve this task? Provider- and
 * model-specific, and CASCADE-AWARE: for Gemini it budgets against the smallest
 * window across the whole fallback chain (callGemini may step down on 429), so a
 * verdict holds no matter which model ends up serving.
 *
 * Two tiers, to keep the common case free of network round-trips:
 *   1. A cheap local OVER-estimate (chars ÷ 2.5). If even the over-count fits,
 *      we're comfortably clear — return immediately, no API call.
 *   2. Otherwise the provider's FREE token-count endpoint for an exact verdict.
 *
 * Never throws: any count-endpoint failure falls back to the (conservative)
 * estimate verdict, so the preflight can't itself break a call.
 * @returns {Promise<{fits:boolean, tokens:number, model:string, provider:string,
 *   budget:number, reservedOutput:number, contextWindow:number, via:string}>}
 */
export async function checkPromptFits(prompt, opts = {}) {
  const { signal, task, hints, responseSchema, cachedPrefix } = normalizeOpts(opts);
  const settings = getAISettings();
  const provider = providerForTask(task, settings);
  const model = pickModel(provider, task, settings);
  const { cap: requestedOutput } = pickMaxTokens(task, hints, provider, model);

  // Budget against the model that serves — for Gemini, the smallest window the
  // cascade could fall to (homogeneous today, but min keeps this correct if a
  // smaller-window model is ever added).
  //
  // GEMINI_ALL_MODEL_IDS, not GEMINI_MODEL_FALLBACKS: the fallback list excludes
  // entitlement-gated models, but a gated model that IS entitled leads the chain
  // and can serve this very call — budgeting over a set that omits it would
  // defeat the whole point of taking a min. Including every registry id is also
  // the conservative direction (it can only lower the budget, never raise it).
  let contextWindow;
  const modelMaxOutput = maxOutputForModel(model);
  if (provider === 'gemini' && GEMINI_ALL_MODEL_IDS.length) {
    contextWindow = Math.min(...GEMINI_ALL_MODEL_IDS.map((m) => modelMeta(m).contextWindow));
  } else {
    contextWindow = modelMeta(model).contextWindow;
  }

  // Tier 1 — cheap local over-estimate (no network).
  const chars = (cachedPrefix?.length || 0) + (prompt?.length || 0)
    + (responseSchema ? JSON.stringify(responseSchema).length : 0);
  const estimate = estimateTokensFromChars(chars);
  const estFit = assessPromptFit({ contextWindow, modelMaxOutput, requestedOutput, promptTokens: estimate });
  if (estFit.fits) {
    return { fits: true, tokens: estimate, model, provider, via: 'estimate',
      budget: estFit.budget, reservedOutput: estFit.reservedOutput, contextWindow: estFit.contextWindow };
  }

  // Tier 2 — authoritative FREE count at the boundary.
  try {
    const tokens = provider === 'claude'
      ? await countClaudeInputTokens(prompt, model, settings.anthropicApiKey, { cachedPrefix, responseSchema, signal })
      : await countGeminiInputTokens(cachedPrefix ? `${cachedPrefix}\n\n${prompt}` : prompt, settings.geminiApiKey, model, { signal });
    const fit = assessPromptFit({ contextWindow, modelMaxOutput, requestedOutput, promptTokens: tokens });
    return { fits: fit.fits, tokens, model, provider, via: 'api',
      budget: fit.budget, reservedOutput: fit.reservedOutput, contextWindow: fit.contextWindow };
  } catch (e) {
    logger.warn(`[LLM] token preflight count failed for task '${task || '?'}' (${e?.message || e}); using local estimate`);
    return { fits: estFit.fits, tokens: estimate, model, provider, via: 'estimate-fallback',
      budget: estFit.budget, reservedOutput: estFit.reservedOutput, contextWindow: estFit.contextWindow };
  }
}

/**
 * Enforce the preflight for a NON-chunkable call: throw a precise, actionable
 * error when the prompt won't fit, instead of letting the provider silently
 * truncate output or stop mid-generation. Chunkable callers (job scoring) call
 * checkPromptFits directly and SPLIT instead of relying on this. Best-effort:
 * checkPromptFits never throws on its own (count failures degrade to the local
 * estimate), so this only fires on a genuine over-budget verdict.
 */
async function assertPromptFits(prompt, opts) {
  const fit = await checkPromptFits(prompt, opts);
  if (!fit.fits) {
    throw new Error(
      `Prompt too large for ${fit.model}: ~${fit.tokens.toLocaleString()} input tokens leave no room for ${fit.reservedOutput.toLocaleString()} reserved output within its ${fit.contextWindow.toLocaleString()}-token context window (input budget ${fit.budget.toLocaleString()}). Reduce the input for task '${opts?.task || 'unknown'}'.`,
    );
  }
  return fit;
}

// Conservative per-attachment token allowance for the vision/document preflight.
// We can cheaply count the TEXT prompt but not image/PDF tokens, so we add this
// generous floor per attachment and fail loud only if even that blows the budget.
// Sized above a Claude image (~1.6K) / a dense PDF page so the estimate over-counts;
// the provider stays the final authority for borderline attachment-heavy payloads.
const ATTACHMENT_TOKEN_ALLOWANCE = 3000;

/**
 * Preflight for an attachment (vision / document) call: precisely counts the TEXT
 * prompt, adds a conservative allowance per attachment, and fails loud when the
 * total leaves no room for the reserved output. Approximate BY DESIGN — exact
 * image/PDF token counts are delegated to the provider (which rejects oversized);
 * this catches the obvious over-window case early with an actionable message.
 */
async function assertAttachmentPromptFits(prompt, { task, hints, signal, attachmentCount = 1 } = {}) {
  const fit = await checkPromptFits(prompt, { task, hints, signal });
  const withAttachments = fit.tokens + Math.max(0, attachmentCount) * ATTACHMENT_TOKEN_ALLOWANCE;
  if (withAttachments > fit.budget) {
    throw new Error(
      `Prompt + ${attachmentCount} attachment(s) too large for ${fit.model}: ~${withAttachments.toLocaleString()} input tokens exceed the ${fit.budget.toLocaleString()}-token budget (window ${fit.contextWindow.toLocaleString()} − reserved output). Reduce inputs for task '${task || 'unknown'}'.`,
    );
  }
  return fit;
}

// ── Public callers ──────────────────────────────────────────────────────────
// All three accept an opts object with { signal, task }. `task` keys into
// TASK_MODELS / TASK_MAX_TOKENS. `signal` is forwarded to the provider call.

/**
 * `cachedPrefix` — optional static string to mark as cacheable. Useful when
 * the caller is about to fire several requests in quick succession that all
 * share an identical prefix (e.g. job-scoring batches: same profile + rules,
 * different job batch each call).
 *
 * Claude: split into a `cache_control: ephemeral` content block followed by
 *   the dynamic prompt. First call writes the cache (1.25x cost on the
 *   prefix); subsequent calls within ~5 min hit it (0.1x cost on the prefix).
 *   Anthropic enforces a minimum cacheable size (~1024 tokens for Sonnet);
 *   short prefixes silently fall through to non-cached behavior.
 * Gemini: 2.5-series models do implicit prefix caching automatically — we
 *   concatenate the prefix into the prompt and let the provider detect the
 *   repeated prefix. No API-level cache plumbing needed.
 */
export async function callLLMText(prompt, opts = {}) {
  const { signal, task, hints, responseSchema, cachedPrefix, excludeModels } = normalizeOpts(opts);
  // Optional by-reference out-param: callers pass `meta: {}` and read back
  // `meta.model` (the model that actually served the call) for per-stage
  // telemetry. The Gemini fallback loop writes it; for Claude there's no
  // fallback so we record the picked model directly.
  const meta     = (opts.meta && typeof opts.meta === 'object') ? opts.meta : null;
  const settings = getAISettings();
  const provider = providerForTask(task, settings);
  const model    = pickModel(provider, task, settings);
  const fullLen  = (prompt?.length || 0) + (cachedPrefix?.length || 0);
  const capHints = { promptLength: fullLen, ...hints };
  let { cap: maxTok, seed: formulaSeed } = pickMaxTokens(task, capHints, provider, model);
  // Context-window preflight (free token count, mostly a local estimate): fail
  // loud BEFORE sending if the prompt + reserved output won't fit the serving
  // model. List-payload callers (job scoring) pre-split via checkPromptFits, so
  // they never reach this; atomic tasks (parse/research/cover-letter) that
  // genuinely overflow get an actionable error instead of a truncated answer.
  await assertPromptFits(prompt, { signal, task, hints, responseSchema, cachedPrefix });
  const attempt = async () => {
    if (provider === 'claude') {
      const raw = await callClaudeText(prompt, model, settings.anthropicApiKey, signal, { maxTokens: maxTok, formulaSeed, expectJson: true, responseSchema, cachedPrefix, task });
      if (meta) meta.model = model;
      return parseAiJson(raw);
    }
    // Gemini: prepend prefix into the prompt; implicit prefix caching on 2.5
    // models picks up the repeated content automatically.
    const merged = cachedPrefix ? `${cachedPrefix}\n\n${prompt}` : prompt;
    return await callGeminiText(merged, settings.geminiApiKey, model, signal, { maxOutputTokens: maxTok, formulaSeed, responseSchema, task, meta, excludeModels });
  };
  // `retriedForCap` caps this at ONE extra attempt no matter what the provider
  // does — a task whose floor keeps rising must never turn a single truncation
  // into an unbounded (and billed) climb toward TOKEN_HARD_CAP.
  let retriedForCap = false;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      const raised = retriedForCap ? null : raisedCapAfterTruncation(err, { signal, usedCap: maxTok, task, hints: capHints, provider, model });
      if (!raised) throw enhanceLLMError(err, provider);
      logger.info(`[LLM] Task '${task || 'unknown'}' truncated at its ${maxTok}-token output cap; retrying once at the raised cap ${raised.cap}.`);
      retriedForCap = true;
      maxTok = raised.cap;
      formulaSeed = raised.seed;
    }
  }
}

// Legacy read/cancel support only. New callers cannot submit Batch API work;
// these functions exist solely to finish or discard jobs paid for by an older
// app version before economy scoring was removed.
export async function getLLMTextBatchStatus(batchId) {
  const settings = getAISettings();
  if (settings.provider !== 'claude') throw new Error('Batch scoring is only available on the Claude provider.');
  return getClaudeBatch(settings.anthropicApiKey, batchId);
}

// Download + parse → { [customId]: parsedObject | null }. Unusable entries
// (errored/expired request, non-JSON body) map to null so the caller's
// reconciliation applies its placeholder fallback.
//
// `budget` is the { task, capsByCustomId } pair the caller persisted at submit
// time; it feeds the token-budget telemetry a batched call would otherwise skip
// entirely (see getClaudeBatchResults). Omitting it — as a sidecar written
// before this existed does — is inert, not an error.
export async function getLLMTextBatchResults(batchId, budget = {}) {
  const settings = getAISettings();
  if (settings.provider !== 'claude') throw new Error('Batch scoring is only available on the Claude provider.');
  const raw = await getClaudeBatchResults(settings.anthropicApiKey, batchId, budget);
  const parsed = {};
  for (const [customId, r] of Object.entries(raw)) {
    if (!r.ok || !r.text) { parsed[customId] = null; continue; }
    try { parsed[customId] = parseAiJson(r.text); }
    catch { parsed[customId] = null; }
  }
  return parsed;
}

export async function cancelLLMTextBatch(batchId) {
  const settings = getAISettings();
  if (settings.provider !== 'claude' || !settings.anthropicApiKey || !batchId) return;
  await cancelClaudeBatch(settings.anthropicApiKey, batchId);
}

/**
 * Free-text generation — returns the model's raw string (NOT JSON-parsed).
 * Use for prose / HTML / research where a JSON envelope would be wrong.
 *
 * `grounding: true` enables live web research (Gemini Google Search tool /
 * Claude server-side web_search). Grounded calls carry their own quota/billing
 * separate from the normal generate tier, and cannot also enforce a JSON
 * responseSchema — which is exactly why this path is free-text.
 */
export async function callLLMRaw(prompt, opts = {}) {
  const { signal, task, hints, grounding, cachedPrefix, excludeModels } = normalizeOpts(opts);
  const meta     = (opts.meta && typeof opts.meta === 'object') ? opts.meta : null;
  const settings = getAISettings();
  const provider = providerForTask(task, settings);
  const model    = pickModel(provider, task, settings);
  const fullLen  = (prompt?.length || 0) + (cachedPrefix?.length || 0);
  const capHints = { promptLength: fullLen, ...hints };
  let { cap: maxTok, seed: formulaSeed } = pickMaxTokens(task, capHints, provider, model);
  // Same context-window preflight as callLLMText (this free-text path can carry
  // large research/synthesis prompts). Grounding adds server-side search tokens
  // we can't predict, but the prompt itself is what we guard here.
  await assertPromptFits(prompt, { signal, task, hints, cachedPrefix });
  const attempt = async () => {
    if (provider === 'claude') {
      const raw = await callClaudeText(prompt, model, settings.anthropicApiKey, signal, { maxTokens: maxTok, formulaSeed, expectJson: false, grounding, task, cachedPrefix });
      if (meta) meta.model = model;
      return raw;
    }
    // Gemini: prepend the cacheable prefix into the prompt (implicit prefix
    // caching picks up the repeated content); mirrors callLLMText.
    const merged = cachedPrefix ? `${cachedPrefix}\n\n${prompt}` : prompt;
    return await callGeminiTextRaw(merged, settings.geminiApiKey, model, signal, { maxOutputTokens: maxTok, formulaSeed, grounding, task, meta, excludeModels });
  };
  // Same single bounded cap retry as callLLMText — this path resolves its cap
  // through the identical pickMaxTokens/effectiveCap mechanism, so a truncation
  // here has the same one-line-away corrected cap waiting for it.
  let retriedForCap = false;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      const raised = retriedForCap ? null : raisedCapAfterTruncation(err, { signal, usedCap: maxTok, task, hints: capHints, provider, model });
      if (!raised) throw enhanceLLMError(err, provider);
      logger.info(`[LLM] Task '${task || 'unknown'}' truncated at its ${maxTok}-token output cap; retrying once at the raised cap ${raised.cap}.`);
      retriedForCap = true;
      maxTok = raised.cap;
      formulaSeed = raised.seed;
    }
  }
}

export async function callLLMVision(imagePaths, prompt, opts = {}) {
  const { signal, task, hints, responseSchema, excludeModels } = normalizeOpts(opts);
  const meta     = (opts.meta && typeof opts.meta === 'object') ? opts.meta : null;
  const settings = getAISettings();
  const provider = providerForTask(task, settings);
  const model    = pickModel(provider, task, settings);
  // photoCount feeds the dynamic sizing function for tasks like
  // vision-product-analysis. Caller-supplied hints win on conflict so a future
  // call site can override when it knows better than the default heuristic.
  const capHints = { photoCount: imagePaths?.length || 0, promptLength: prompt?.length || 0, ...hints };
  let { cap: maxTok, seed: formulaSeed } = pickMaxTokens(task, capHints, provider, model);
  // Preflight the text prompt + a per-image allowance (image tokens themselves
  // are the provider's authority). Fails loud before sending if clearly over.
  await assertAttachmentPromptFits(prompt, { task, hints, signal, attachmentCount: imagePaths?.length || 0 });
  const attempt = async () => {
    if (provider === 'claude') {
      const raw = await callClaudeVision(imagePaths, prompt, model, settings.anthropicApiKey, signal, { maxTokens: maxTok, formulaSeed, expectJson: true, responseSchema, task });
      if (meta) meta.model = model;
      return parseAiJson(raw);
    }
    return await callGeminiVision(imagePaths, prompt, settings.geminiApiKey, model, signal, { maxOutputTokens: maxTok, formulaSeed, responseSchema, task, meta, excludeModels });
  };
  // Same single bounded cap retry as callLLMText/callLLMRaw — a multi-photo
  // upload (vision-product-analysis) has no chunking path to fall back on, so
  // one retry at the raised cap is the difference between a completed call
  // and a hard failure.
  let retriedForCap = false;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      const raised = retriedForCap ? null : raisedCapAfterTruncation(err, { signal, usedCap: maxTok, task, hints: capHints, provider, model });
      if (!raised) throw enhanceLLMError(err, provider);
      logger.info(`[LLM] Task '${task || 'unknown'}' truncated at its ${maxTok}-token output cap; retrying once at the raised cap ${raised.cap}.`);
      retriedForCap = true;
      maxTok = raised.cap;
      formulaSeed = raised.seed;
    }
  }
}

export async function callLLMDocument(filePath, prompt, opts = {}) {
  // A document node's filePath is sourced from loaded canvas JSON — an
  // untrusted/shared canvas could point a node at a sensitive system/
  // credential path. callClaudeDocument/callGeminiDocument re-check this
  // too, but the Word-doc branch below bypasses both (it shells out to
  // textutil directly), so gate here as the single shared entry point.
  if (isSensitivePath(path.resolve(String(filePath || '')))) {
    throw new Error(`Refusing to read a sensitive system/credential path as an AI attachment: ${filePath}`);
  }
  const { signal, task, hints, responseSchema, cachedPrefix, excludeModels } = normalizeOpts(opts);
  // Word docs (.docx / legacy .doc) can't be sent as inline data — Gemini 400s on
  // the OOXML MIME and Claude reads the ZIP bytes as garbage. Extract the text via
  // macOS textutil and route through the normal TEXT path, which every provider
  // accepts (and which runs its own window preflight + caching). This also makes
  // legacy .doc work, which both document handlers previously rejected outright.
  if (isWordDoc(filePath)) {
    const text = await extractWordText(filePath);
    return callLLMText(`${prompt}\n\n[Attached File: ${path.basename(filePath)}]\n${text}`,
      { signal, task, hints, responseSchema, cachedPrefix, excludeModels });
  }
  const settings = getAISettings();
  const provider = providerForTask(task, settings);
  const model    = pickModel(provider, task, settings);
  const capHints = { promptLength: prompt?.length || 0, ...hints };
  let { cap: maxTok, seed: formulaSeed } = pickMaxTokens(task, capHints, provider, model);
  // Preflight the text prompt + one document allowance (the file's own tokens —
  // PDF pages, etc. — remain the provider's authority). A pathologically large
  // career-file/résumé fails loud here instead of mid-extraction truncation.
  await assertAttachmentPromptFits(prompt, { task, hints, signal, attachmentCount: 1 });
  const attempt = async () => {
    if (provider === 'claude') {
      const raw = await callClaudeDocument(filePath, prompt, model, settings.anthropicApiKey, signal, { maxTokens: maxTok, formulaSeed, expectJson: true, responseSchema, task });
      return parseAiJson(raw);
    }
    return await callGeminiDocument(filePath, prompt, settings.geminiApiKey, model, signal, { maxOutputTokens: maxTok, formulaSeed, responseSchema, task, excludeModels });
  };
  // Same single bounded cap retry as callLLMText/callLLMRaw/callLLMVision —
  // career-file-extract's non-.docx path lands here with no chunking path to
  // fall back on, so a truncated career-file parse gets one shot at the
  // raised cap instead of hard-failing the whole run.
  let retriedForCap = false;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      const raised = retriedForCap ? null : raisedCapAfterTruncation(err, { signal, usedCap: maxTok, task, hints: capHints, provider, model });
      if (!raised) throw enhanceLLMError(err, provider);
      logger.info(`[LLM] Task '${task || 'unknown'}' truncated at its ${maxTok}-token output cap; retrying once at the raised cap ${raised.cap}.`);
      retriedForCap = true;
      maxTok = raised.cap;
      formulaSeed = raised.seed;
    }
  }
}

// Back-compat shim: old call sites passed `signal` as the second positional.
// Detect a plain AbortSignal and wrap it as `{ signal, task: undefined }`.
// New call sites should pass `{ signal, task }`.
function normalizeOpts(opts) {
  if (opts && typeof opts === 'object' && (opts.task !== undefined || opts.signal !== undefined || opts.hints !== undefined || opts.responseSchema !== undefined || opts.cachedPrefix !== undefined || opts.grounding !== undefined || opts.excludeModels !== undefined || opts.meta !== undefined || Object.keys(opts).length === 0)) {
    return { signal: opts.signal, task: opts.task, hints: opts.hints || {}, responseSchema: opts.responseSchema, cachedPrefix: opts.cachedPrefix, grounding: !!opts.grounding, excludeModels: Array.isArray(opts.excludeModels) ? opts.excludeModels : [] };
  }
  // Anything else (a raw AbortSignal, undefined, etc.) → treat as signal.
  return { signal: opts, task: undefined, hints: {}, responseSchema: undefined, cachedPrefix: undefined, grounding: false, excludeModels: [] };
}

/**
 * Settings-panel support: the live Claude family → model-id map, so the
 * live group dropdowns can show "Sonnet — claude-sonnet-5" instead of a bare
 * family name (proof the always-latest resolver is actually working, not
 * just a label). A cheap `primeClaudeModels()` call first means the panel
 * reflects a just-added API key immediately rather than whatever the
 * process happened to resolve at startup — primeClaudeModels() no-ops when
 * the in-memory/on-disk snapshot is already fresh (modelResolver.js), so
 * this costs nothing on the common "already primed" path.
 */
export function registerLlmHandlers() {
  // This is UI decoration, never a reason for the Settings panel to hang on a
  // dead network. The resolver keeps the floor snapshot on timeout/failure, so
  // the panel can still render usable family names and ids when available.
  handleSafe('get-claude-model-map', async (_event, _args, signal) => {
    // Do not hand this UI request's timeout signal to the shared resolver:
    // another concurrently-starting job may be awaiting the same discovery.
    // Race this caller instead, leaving the background resolution able to warm
    // the snapshot for the next panel open/run.
    let abortListener;
    const aborted = new Promise((_, reject) => {
      abortListener = () => reject(signal?.reason || new Error('Model-map refresh timed out'));
      if (signal?.aborted) abortListener();
      else signal?.addEventListener('abort', abortListener, { once: true });
    });
    try {
      await Promise.race([primeClaudeModels(), aborted]);
    } finally {
      if (abortListener) signal?.removeEventListener('abort', abortListener);
    }
    return { resolved: resolvedClaudeModels(), groupDefaults: { ...GROUP_DEFAULT_FAMILY } };
  }, 12_000);

  // Text polish lives HERE, not in registerGeminiHandlers, because it is not a
  // Gemini feature — it's an ordinary per-task LLM call that happens to return
  // prose. It used to sit in gemini.js and hand-roll its own provider branch:
  // a hardcoded `'gemini-3.1-flash-lite'` literal with a comment claiming it
  // "matches TASK_MODELS['text-polish'].gemini", plus a separate
  // callClaudeText(HAIKU) branch. Both had already drifted — TASK_MODELS moved
  // text-polish to gemini-3.5-flash-lite, and the Claude side hardcoded HAIKU
  // instead of honoring the user's `light`-group family pick — because a
  // duplicated routing decision only stays correct until someone edits the
  // original. gemini.js couldn't import modelForTask to fix it in place
  // (llm.js already imports gemini.js; that's a cycle), so the handler moves
  // to the module that owns routing.
  //
  // callLLMRaw, not callLLMText: polish returns prose, and callLLMRaw is the
  // raw-text path that skips JSON parsing. (The old comment claiming polish
  // "can't share callLLMText" was right about JSON but predated callLLMRaw.)
  // The Gemini side already cascaded — it called callGemini, which IS the
  // cascade — so what this actually fixes is the model ids: the Gemini literal
  // was a generation stale, and the Claude branch ignored the user's
  // `light`-group family pick in favour of a hardcoded HAIKU.
  handleSafe('ai-polish-text', async (event, text, signal) => {
    const prompt = `You are an AI assistant in a visual workspace app. Polish the following text. Make it clear, concise, and professional. Output ONLY the improved text, without quotes or conversational filler. Keep original markdown formatting if any. The text is:\n\n${text}`;
    const raw = await callLLMRaw(prompt, { signal, task: 'text-polish' });
    return { text: String(raw || '').trim() };
  });
}

function enhanceLLMError(error, provider) {
  // If the error indicates a rate limit or exhaustion, mark it as RATE_LIMIT
  // so the frontend can catch it and display the model selector. Check the SDK's
  // structured status (429) directly in addition to message substrings — relying
  // on the message alone is fragile if a provider changes its error-string format.
  const msg = error.message?.toLowerCase() || '';
  // \b429\b (not a substring test) so digit runs like "4291 visible tokens"
  // can't masquerade as an HTTP 429 — gemini.js's hasRateLimit uses the same
  // boundary match; keep the two in lockstep.
  if (
    error.status === 429 ||
    msg.includes('rate limit') ||
    /\b429\b/.test(msg) ||
    msg.includes('insufficient funds') ||
    msg.includes('quota')
  ) {
    error.isRateLimit = true;
    error.provider = provider;
  }
  return error;
}
