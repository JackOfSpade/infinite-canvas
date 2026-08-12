import { getAISettings } from './settings.js';
import { callGeminiText, callGeminiTextRaw, callGeminiVision, callGeminiDocument, countGeminiInputTokens, GEMINI_MODEL_FALLBACKS } from './gemini.js';
import { callClaudeText, callClaudeVision, callClaudeDocument, createClaudeBatch, getClaudeBatch, getClaudeBatchResults, cancelClaudeBatch, countClaudeInputTokens } from './claude.js';
import { parseAiJson } from './jsonRepair.js';
import { isWordDoc, extractWordText } from './docUtils.js';
import { isSensitivePath } from '../utils/pathSafety.js';
import { effectiveCap } from './tokenBudget.js';
import path from 'path';
import { priceSynthesisMaxTokens } from './resultCaps.js';
import { modelMeta, maxOutputForModel, assessPromptFit, estimateTokensFromChars } from './tokenWindow.js';
import { CLAUDE_FAMILY, isClaudeFamilyToken, claudeModelFor } from './modelResolver.js';
import { logger } from '../logger.js';

/**
 * Per-task model selection.
 *
 * Each call site declares its `task` and this layer picks the right model
 * for the active provider. Replaces the old "user picks a model in Settings"
 * UX — quality+cost decisions belong with whoever wrote the prompt, not
 * with the user, who has no signal about which model fits which task.
 *
 * Claude entries below are FAMILY TOKENS (CLAUDE_FAMILY.OPUS/.SONNET/.HAIKU),
 * not literal model ids — pickModel resolves each against the live Models API
 * snapshot (modelResolver.js's claudeModelFor), falling back to the pinned
 * MODEL_FLOOR when discovery hasn't run yet or the API is unreachable. This
 * is what keeps the app on the CURRENT Claude generation automatically
 * instead of a literal id silently going stale — the table used to pin
 * claude-opus-4-8 / claude-sonnet-4-6, two whole generations behind the live
 * claude-opus-5 / claude-sonnet-5, at identical or lower price (see
 * modelResolver.js and docs/resume-achievement-mining-design.md §8). The
 * Gemini column stays literal — it isn't resolver-driven.
 *
 * Model choices, in short:
 *   - Sonnet tier: vision identification, price synthesis, resume parse,
 *     job scoring, query generation, bucketing, company research, the
 *     achievement REFUTER — anywhere quality compounds or the output is
 *     user-facing. Query gen and bucketing are on Sonnet deliberately: query
 *     quality gates which jobs are ever DISCOVERED, and the bucketing
 *     role-consolidation IS the user-facing results hierarchy. Both run once
 *     per search (not per-job), so the quality win is cheap.
 *   - Haiku tier: page status classify, text polish, platform-fit — short
 *     structured outputs (enum + a sentence) where Sonnet adds no real
 *     quality (3x cheaper, no user-visible difference).
 *   - Gemini 3.5 Flash: preferred for Sonnet/Opus-quality tasks on the API-key
 *     path. AI Studio currently reports 0/0 free-tier quota for Pro models, so
 *     they are excluded from the fallback chain until quota exists.
 *   - Gemini 3.1 Flash-Lite: matches Haiku's tasks while avoiding the 2.5
 *     Flash-Lite access restriction for new/inactive projects.
 *   - Opus tier: used for the two application-GENERATION tasks
 *     (application-resume, application-cover-letter) — the employer-facing
 *     documents where writing quality converts to interviews — and for
 *     career-achievement-mining, the highest-leverage reasoning pass in the
 *     whole pipeline. Mining runs ONCE PER HUB (cached on the jobhub node),
 *     not per application, so its Opus premium is amortized across every job
 *     generated from that hub rather than paid per application the way the
 *     two generation tasks pay it. At Opus's ~1.67x Sonnet input/output (far
 *     below the old Opus-4.1 5x) the delta is worth it on these three tasks
 *     and nowhere else; everything else stays on Sonnet/Haiku. Don't
 *     blanket-promote — add a row only with a real reason.
 */
const TASK_MODELS = {
  'vision-product-analysis':   { claude: CLAUDE_FAMILY.SONNET, gemini: 'gemini-3.5-flash' },
  'price-synthesis':           { claude: CLAUDE_FAMILY.SONNET, gemini: 'gemini-3.5-flash' },
  // Bundle pricing is a pricing JUDGMENT (synergy reasoning across items), so it
  // gets the same Sonnet tier as price-synthesis — not the cheaper Haiku used for
  // mechanical classification (per the quality-over-cost preference on pricing).
  'bundle-price-synthesis':    { claude: CLAUDE_FAMILY.SONNET, gemini: 'gemini-3.5-flash' },
  'platform-fit-assessment':   { claude: CLAUDE_FAMILY.HAIKU,  gemini: 'gemini-3.1-flash-lite' },
  'page-status-classify':      { claude: CLAUDE_FAMILY.HAIKU,  gemini: 'gemini-3.1-flash-lite' },
  // Marketplace Status Module hub scan — mechanical extraction of action items
  // from a seller dashboard / notification feed, same tier as page-status-classify
  // (scanning, not pricing judgment, so Haiku per the quality-over-cost split).
  'marketplace-hub-scan':      { claude: CLAUDE_FAMILY.HAIKU,  gemini: 'gemini-3.1-flash-lite' },
  'resume-parse':              { claude: CLAUDE_FAMILY.SONNET, gemini: 'gemini-3.5-flash' },
  'career-file-extract':       { claude: CLAUDE_FAMILY.SONNET, gemini: 'gemini-3.5-flash' },
  'job-query-generation':      { claude: CLAUDE_FAMILY.SONNET, gemini: 'gemini-3.5-flash' },
  'job-scoring':               { claude: CLAUDE_FAMILY.SONNET, gemini: 'gemini-3.5-flash' },
  'job-bucketing':             { claude: CLAUDE_FAMILY.SONNET, gemini: 'gemini-3.5-flash' },
  // Application generation (résumé + cover letter from the design system).
  // Quality compounds here — the output is a polished document a human sends
  // to a recruiter, where writing nuance + judgment convert to interviews —
  // so the two GENERATION tasks get the Opus tier on the Claude path. This is
  // one of the few places the Opus delta clearly pays off. company-research
  // stays on Sonnet: it's grounded summarization that FEEDS the generation,
  // not the employer-facing artifact.
  'company-research':          { claude: CLAUDE_FAMILY.SONNET, gemini: 'gemini-3.5-flash' },
  'application-resume':        { claude: CLAUDE_FAMILY.OPUS,   gemini: 'gemini-3.5-flash' },
  'application-cover-letter':  { claude: CLAUDE_FAMILY.OPUS,   gemini: 'gemini-3.5-flash' },
  // Achievement mining (résumé design doc §3.1) derives accomplishments by
  // JOINING facts scattered across the corpus — e.g. two balance sheets + a
  // tenure date → "cut debt 74%" — which no other task attempts. It's the
  // highest-leverage reasoning pass in the whole pipeline, and it runs ONCE
  // PER HUB (cached on the jobhub node, reused by every application generated
  // from it), not per application — so Opus's premium is amortized rather
  // than paid on every Generate click the way application-resume pays it.
  'career-achievement-mining': { claude: CLAUDE_FAMILY.OPUS,   gemini: 'gemini-3.5-flash' },
  // The refute pass uses a DIFFERENT model from the miner ON PURPOSE — that
  // difference is what buys real independence (a model re-checking its own
  // reasoning tends to just re-confirm it). Sonnet is also cheaper, which is
  // a welcome side effect but not the reason for the choice.
  'career-achievement-refute': { claude: CLAUDE_FAMILY.SONNET, gemini: 'gemini-3.5-flash' },
  'text-polish':               { claude: CLAUDE_FAMILY.HAIKU,  gemini: 'gemini-3.1-flash-lite' },
  // Default — used when a caller forgets to pass `task`. Logged as a warning
  // below so we notice unmapped sites; tuned to a safe-middle.
  'default':                   { claude: CLAUDE_FAMILY.SONNET, gemini: 'gemini-3.5-flash' },
};

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
  // Job scoring on the active Flash-tier Gemini with thinking: real-world telemetry shows
  // ~175 thinking tokens per job plus ~150 visible tokens per job (score +
  // 1-sentence rationale). 15-job batch with old formula (512 + 15*150 =
  // 2762) had thoughts=2647 alone — barely 100 visible tokens before
  // truncation. Formula: 2500 base + 420/item gives 15→8800, 50→23500, capped
  // at 24576 so a pathological batch can't request runaway billing. The 420
  // (was 300) reflects the richer multi-sentence `reasoning` we now ask for
  // (truncated on the card, expandable) — output is billed on actual tokens so
  // the headroom is free, and effectiveCap self-heals if a batch still clips.
  'job-scoring':               ({ itemCount = 10 } = {}) =>
    Math.min(24576, 2500 + itemCount * 420),
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
  // Research: synthesized web findings covering BOTH the company (culture,
  // products, recent news, stage) AND the specific role (responsibilities,
  // requirements, emphasized skills) — the primary job-context source. Grounded
  // calls also spend tokens assembling search results, so give room for a
  // thorough two-part synthesis.
  'company-research':          6144,
  // Résumé generation emits a full <main class="page"> block of HTML (several
  // roles × bullets, skills, education) — the largest free-text output here. A
  // truncation produces malformed HTML → a broken PDF, so size well past a
  // 2-page senior résumé. Unused cap is free (billed on actual output).
  'application-resume':        12288,
  'application-cover-letter':  3072,  // structured letterhead + 3-4 paragraphs
  // A ledger of ~40 items, each carrying a verbatim evidence quote AND a
  // human-readable derivation string, is a larger output than a single file's
  // transcription — deliberately set above career-file-extract's 16384 for
  // the same reason that cap is generous: a truncated ledger silently DROPS
  // achievements rather than erroring, which is worse than an oversized cap.
  // Caps bill on actual output, so the headroom is free.
  'career-achievement-mining': 24576,
  // The refuter returns one verdict per ledger item (id + verdict enum + a
  // short reason + suggested attribution/caveat) — far smaller than the
  // ledger it's attacking.
  'career-achievement-refute': 8192,
  'text-polish':               1024,  // light edit
  'default':                   2048,
};

function resolveTask(task) {
  if (!task || !TASK_MODELS[task]) {
    logger.warn(`[LLM] Unmapped task='${task}', using 'default' (Sonnet tier / Gemini 3.5 Flash, 2048 max_tokens). Add it to TASK_MODELS.`);
    return 'default';
  }
  return task;
}

// The set of task ids the current build actually issues (union of the model +
// max-tokens maps, minus the 'default' fallback). The persisted token-budget
// store accumulates a rolling sample per task and never prunes renamed/removed
// keys, so a stale task can haunt bug reports forever — callers use this to tell
// live tasks from persisted ghosts (e.g. an old 'parse-pasted-jobs').
export function getKnownTaskIds() {
  return new Set(
    [...Object.keys(TASK_MODELS), ...Object.keys(TASK_MAX_TOKENS)].filter(k => k !== 'default')
  );
}

function pickModel(provider, task) {
  const t = resolveTask(task);
  const raw = TASK_MODELS[t][provider] || TASK_MODELS['default'][provider];
  // TASK_MODELS' claude column holds FAMILY TOKENS, not literal ids — resolve
  // against the live snapshot (modelResolver.js). A Gemini id (or, in
  // principle, any literal Claude id a future call site hardcodes) is already
  // a real model id and passes through unchanged.
  return provider === 'claude' && isClaudeFamilyToken(raw) ? claudeModelFor(raw) : raw;
}

/**
 * The model id that will actually serve `task` for the active provider — the same
 * choice checkPromptFits / callLLMText make, exposed so a caller can size work to
 * that model BEFORE the call (e.g. jobScoringBatchSize). Returns the PRIMARY
 * model; a Gemini cascade may use any compatible fallback, but those share the
 * window/output limits the sizing depends on.
 */
export function modelForTask(task) {
  const provider = getAISettings().provider === 'claude' ? 'claude' : 'gemini';
  return pickModel(provider, task);
}

function pickMaxTokens(task, hints = {}) {
  const t = resolveTask(task);
  const entry = TASK_MAX_TOKENS[t] ?? TASK_MAX_TOKENS['default'];
  const seed = typeof entry === 'function' ? entry(hints) : entry;
  // The TASK_MAX_TOKENS value above is the calibrated seed/floor. effectiveCap
  // raises it toward observed p95 usage if a model has churned to use more than
  // the formula assumed (never below the seed; never above the 24576 hard cap).
  return { cap: effectiveCap(t, seed), seed };
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
  const provider = settings.provider === 'claude' ? 'claude' : 'gemini';
  const model = pickModel(provider, task);
  const { cap: requestedOutput } = pickMaxTokens(task, hints);

  // Budget against the model that serves — for Gemini, the smallest window the
  // cascade could fall to (homogeneous today, but min keeps this correct if a
  // smaller-window model is ever added to GEMINI_MODEL_FALLBACKS).
  let contextWindow;
  const modelMaxOutput = maxOutputForModel(model);
  if (provider === 'gemini' && GEMINI_MODEL_FALLBACKS.length) {
    contextWindow = Math.min(...GEMINI_MODEL_FALLBACKS.map((m) => modelMeta(m).contextWindow));
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
  const { signal, task, hints, responseSchema, cachedPrefix } = normalizeOpts(opts);
  // Optional by-reference out-param: callers pass `meta: {}` and read back
  // `meta.model` (the model that actually served the call) for per-stage
  // telemetry. The Gemini fallback loop writes it; for Claude there's no
  // fallback so we record the picked model directly.
  const meta     = (opts.meta && typeof opts.meta === 'object') ? opts.meta : null;
  const settings = getAISettings();
  const model    = pickModel(settings.provider === 'claude' ? 'claude' : 'gemini', task);
  const fullLen  = (prompt?.length || 0) + (cachedPrefix?.length || 0);
  const { cap: maxTok, seed: formulaSeed } = pickMaxTokens(task, { promptLength: fullLen, ...hints });
  // Context-window preflight (free token count, mostly a local estimate): fail
  // loud BEFORE sending if the prompt + reserved output won't fit the serving
  // model. List-payload callers (job scoring) pre-split via checkPromptFits, so
  // they never reach this; atomic tasks (parse/research/cover-letter) that
  // genuinely overflow get an actionable error instead of a truncated answer.
  await assertPromptFits(prompt, { signal, task, hints, responseSchema, cachedPrefix });
  try {
    if (settings.provider === 'claude') {
      const raw = await callClaudeText(prompt, model, settings.anthropicApiKey, signal, { maxTokens: maxTok, formulaSeed, expectJson: true, responseSchema, cachedPrefix, task });
      if (meta) meta.model = model;
      return parseAiJson(raw);
    }
    // Gemini: prepend prefix into the prompt; implicit prefix caching on 2.5
    // models picks up the repeated content automatically.
    const merged = cachedPrefix ? `${cachedPrefix}\n\n${prompt}` : prompt;
    return await callGeminiText(merged, settings.geminiApiKey, model, signal, { maxOutputTokens: maxTok, formulaSeed, responseSchema, task, meta });
  } catch (err) {
    throw enhanceLLMError(err, settings.provider);
  }
}

// ── Batch text/JSON (async, Claude-only) ───────────────────────────────────
// The Batch API is ~50% cheaper but async (results within 24h). Only Claude is
// supported (free-tier Gemini is already $0); callers must gate on provider.
// Each item: { customId, prompt, hints }. Per-item max_tokens is resolved from
// the task budget + hints exactly like callLLMText, so a batched call sizes its
// output identically to a real-time one. cachedPrefix is sent as an ephemeral
// cache block per request (the shared profile+rules), stacking the caching
// discount on top of the batch discount.
export async function submitLLMTextBatch(items, { task, responseSchema, cachedPrefix } = {}) {
  const settings = getAISettings();
  if (settings.provider !== 'claude') throw new Error('Batch scoring is only available on the Claude provider.');
  if (!settings.anthropicApiKey) throw new Error('Batch scoring requires an Anthropic API key (set it in Settings).');
  const model = pickModel('claude', task);
  const requests = (items || []).map((it) => {
    const fullLen = (it.prompt?.length || 0) + (cachedPrefix?.length || 0);
    const { cap: maxTokens } = pickMaxTokens(task, { promptLength: fullLen, ...(it.hints || {}) });
    return { customId: it.customId, userContent: it.prompt, model, maxTokens, responseSchema, cachedPrefix, expectJson: !responseSchema };
  });
  const res = await createClaudeBatch(settings.anthropicApiKey, requests);
  return { batchId: res.id, status: res.status, count: requests.length, model };
}

export async function getLLMTextBatchStatus(batchId) {
  const settings = getAISettings();
  if (settings.provider !== 'claude') throw new Error('Batch scoring is only available on the Claude provider.');
  return getClaudeBatch(settings.anthropicApiKey, batchId);
}

// Download + parse → { [customId]: parsedObject | null }. Unusable entries
// (errored/expired request, non-JSON body) map to null so the caller's
// reconciliation applies its placeholder fallback.
export async function getLLMTextBatchResults(batchId) {
  const settings = getAISettings();
  if (settings.provider !== 'claude') throw new Error('Batch scoring is only available on the Claude provider.');
  const raw = await getClaudeBatchResults(settings.anthropicApiKey, batchId);
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
  const { signal, task, hints, grounding, cachedPrefix } = normalizeOpts(opts);
  const meta     = (opts.meta && typeof opts.meta === 'object') ? opts.meta : null;
  const settings = getAISettings();
  const provider = settings.provider === 'claude' ? 'claude' : 'gemini';
  const model    = pickModel(provider, task);
  const fullLen  = (prompt?.length || 0) + (cachedPrefix?.length || 0);
  const { cap: maxTok, seed: formulaSeed } = pickMaxTokens(task, { promptLength: fullLen, ...hints });
  // Same context-window preflight as callLLMText (this free-text path can carry
  // large research/synthesis prompts). Grounding adds server-side search tokens
  // we can't predict, but the prompt itself is what we guard here.
  await assertPromptFits(prompt, { signal, task, hints, cachedPrefix });
  try {
    if (provider === 'claude') {
      const raw = await callClaudeText(prompt, model, settings.anthropicApiKey, signal, { maxTokens: maxTok, formulaSeed, expectJson: false, grounding, task, cachedPrefix });
      if (meta) meta.model = model;
      return raw;
    }
    // Gemini: prepend the cacheable prefix into the prompt (implicit prefix
    // caching picks up the repeated content); mirrors callLLMText.
    const merged = cachedPrefix ? `${cachedPrefix}\n\n${prompt}` : prompt;
    return await callGeminiTextRaw(merged, settings.geminiApiKey, model, signal, { maxOutputTokens: maxTok, formulaSeed, grounding, task, meta });
  } catch (err) {
    throw enhanceLLMError(err, provider);
  }
}

export async function callLLMVision(imagePaths, prompt, opts = {}) {
  const { signal, task, hints, responseSchema } = normalizeOpts(opts);
  const meta     = (opts.meta && typeof opts.meta === 'object') ? opts.meta : null;
  const settings = getAISettings();
  const model    = pickModel(settings.provider === 'claude' ? 'claude' : 'gemini', task);
  // photoCount feeds the dynamic sizing function for tasks like
  // vision-product-analysis. Caller-supplied hints win on conflict so a future
  // call site can override when it knows better than the default heuristic.
  const { cap: maxTok, seed: formulaSeed } = pickMaxTokens(task, { photoCount: imagePaths?.length || 0, promptLength: prompt?.length || 0, ...hints });
  // Preflight the text prompt + a per-image allowance (image tokens themselves
  // are the provider's authority). Fails loud before sending if clearly over.
  await assertAttachmentPromptFits(prompt, { task, hints, signal, attachmentCount: imagePaths?.length || 0 });
  try {
    if (settings.provider === 'claude') {
      const raw = await callClaudeVision(imagePaths, prompt, model, settings.anthropicApiKey, signal, { maxTokens: maxTok, formulaSeed, expectJson: true, responseSchema, task });
      if (meta) meta.model = model;
      return parseAiJson(raw);
    }
    return await callGeminiVision(imagePaths, prompt, settings.geminiApiKey, model, signal, { maxOutputTokens: maxTok, formulaSeed, responseSchema, task, meta });
  } catch (err) {
    throw enhanceLLMError(err, settings.provider);
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
  const { signal, task, hints, responseSchema, cachedPrefix } = normalizeOpts(opts);
  // Word docs (.docx / legacy .doc) can't be sent as inline data — Gemini 400s on
  // the OOXML MIME and Claude reads the ZIP bytes as garbage. Extract the text via
  // macOS textutil and route through the normal TEXT path, which every provider
  // accepts (and which runs its own window preflight + caching). This also makes
  // legacy .doc work, which both document handlers previously rejected outright.
  if (isWordDoc(filePath)) {
    const text = await extractWordText(filePath);
    return callLLMText(`${prompt}\n\n[Attached File: ${path.basename(filePath)}]\n${text}`,
      { signal, task, hints, responseSchema, cachedPrefix });
  }
  const settings = getAISettings();
  const model    = pickModel(settings.provider === 'claude' ? 'claude' : 'gemini', task);
  const { cap: maxTok, seed: formulaSeed } = pickMaxTokens(task, { promptLength: prompt?.length || 0, ...hints });
  // Preflight the text prompt + one document allowance (the file's own tokens —
  // PDF pages, etc. — remain the provider's authority). A pathologically large
  // career-file/résumé fails loud here instead of mid-extraction truncation.
  await assertAttachmentPromptFits(prompt, { task, hints, signal, attachmentCount: 1 });
  try {
    if (settings.provider === 'claude') {
      const raw = await callClaudeDocument(filePath, prompt, model, settings.anthropicApiKey, signal, { maxTokens: maxTok, formulaSeed, expectJson: true, responseSchema, task });
      return parseAiJson(raw);
    }
    return await callGeminiDocument(filePath, prompt, settings.geminiApiKey, model, signal, { maxOutputTokens: maxTok, formulaSeed, responseSchema, task });
  } catch (err) {
    throw enhanceLLMError(err, settings.provider);
  }
}

// Back-compat shim: old call sites passed `signal` as the second positional.
// Detect a plain AbortSignal and wrap it as `{ signal, task: undefined }`.
// New call sites should pass `{ signal, task }`.
function normalizeOpts(opts) {
  if (opts && typeof opts === 'object' && (opts.task !== undefined || opts.signal !== undefined || opts.hints !== undefined || opts.responseSchema !== undefined || opts.cachedPrefix !== undefined || opts.grounding !== undefined || Object.keys(opts).length === 0)) {
    return { signal: opts.signal, task: opts.task, hints: opts.hints || {}, responseSchema: opts.responseSchema, cachedPrefix: opts.cachedPrefix, grounding: !!opts.grounding };
  }
  // Anything else (a raw AbortSignal, undefined, etc.) → treat as signal.
  return { signal: opts, task: undefined, hints: {}, responseSchema: undefined, cachedPrefix: undefined, grounding: false };
}

function enhanceLLMError(error, provider) {
  // If the error indicates a rate limit or exhaustion, mark it as RATE_LIMIT
  // so the frontend can catch it and display the model selector. Check the SDK's
  // structured status (429) directly in addition to message substrings — relying
  // on the message alone is fragile if a provider changes its error-string format.
  const msg = error.message?.toLowerCase() || '';
  if (
    error.status === 429 ||
    msg.includes('rate limit') ||
    msg.includes('429') ||
    msg.includes('insufficient funds') ||
    msg.includes('quota')
  ) {
    error.isRateLimit = true;
    error.provider = provider;
  }
  return error;
}
