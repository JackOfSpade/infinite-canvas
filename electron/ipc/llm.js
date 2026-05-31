import { getAISettings } from './settings.js';
import { callGeminiText, callGeminiTextRaw, callGeminiVision, callGeminiDocument, parseGeminiJSON } from './gemini.js';
import { callClaudeText, callClaudeVision, callClaudeDocument, createClaudeBatch, getClaudeBatch, getClaudeBatchResults, cancelClaudeBatch } from './claude.js';
import { effectiveCap } from './tokenBudget.js';
import { priceSynthesisMaxTokens } from './resultCaps.js';
import { logger } from '../logger.js';

/**
 * Per-task model selection.
 *
 * Each call site declares its `task` and this layer picks the right model
 * for the active provider. Replaces the old "user picks a model in Settings"
 * UX — quality+cost decisions belong with whoever wrote the prompt, not
 * with the user, who has no signal about which model fits which task.
 *
 * Model choices, in short:
 *   - Sonnet 4.6: vision identification, price synthesis, resume parse,
 *     job scoring, query generation, bucketing, cover letters, interview
 *     prep, application generation — anywhere quality compounds or the
 *     output is user-facing. Query gen and bucketing are on Sonnet
 *     deliberately: query quality gates which jobs are ever DISCOVERED, and
 *     the bucketing role-consolidation IS the user-facing results hierarchy.
 *     Both run once per search (not per-job), so the quality win is cheap.
 *   - Haiku 4.5: page status classify, text polish, platform-fit — short
 *     structured outputs (enum + a sentence) where Sonnet adds no real
 *     quality (3x cheaper, no user-visible difference).
 *   - Gemini 3.5 Flash: matches Sonnet's tasks (good enough, materially
 *     newer than the 2.5 Flash line Google is restricting on June 15, 2026).
 *   - Gemini 3.1 Flash-Lite: matches Haiku's tasks while avoiding the 2.5
 *     Flash-Lite access restriction for new/inactive projects.
 *   - Opus: not used. 5x input / 1.67x output over Sonnet with no current
 *     task needing the delta. Add a row here if a future agentic flow
 *     actually justifies it.
 */
const TASK_MODELS = {
  'vision-product-analysis':   { claude: 'claude-sonnet-4-6',         gemini: 'gemini-3.5-flash'      },
  'price-synthesis':           { claude: 'claude-sonnet-4-6',         gemini: 'gemini-3.5-flash'      },
  'platform-fit-assessment':   { claude: 'claude-haiku-4-5-20251001', gemini: 'gemini-3.1-flash-lite' },
  'page-status-classify':      { claude: 'claude-haiku-4-5-20251001', gemini: 'gemini-3.1-flash-lite' },
  'resume-parse':              { claude: 'claude-sonnet-4-6',         gemini: 'gemini-3.5-flash'      },
  'career-file-extract':       { claude: 'claude-sonnet-4-6',         gemini: 'gemini-3.5-flash'      },
  'job-query-generation':      { claude: 'claude-sonnet-4-6',         gemini: 'gemini-3.5-flash'      },
  'job-scoring':               { claude: 'claude-sonnet-4-6',         gemini: 'gemini-3.5-flash'      },
  'job-bucketing':             { claude: 'claude-sonnet-4-6',         gemini: 'gemini-3.5-flash'      },
  'cover-letter-generation':   { claude: 'claude-sonnet-4-6',         gemini: 'gemini-3.5-flash'      },
  'interview-prep-generation': { claude: 'claude-sonnet-4-6',         gemini: 'gemini-3.5-flash'      },
  // Application generation (résumé + cover letter from the design system).
  // Quality compounds here — the output is a polished PDF a human sends to a
  // recruiter — so it gets the strong model on both providers.
  'company-research':          { claude: 'claude-sonnet-4-6',         gemini: 'gemini-3.5-flash'      },
  'application-resume':        { claude: 'claude-sonnet-4-6',         gemini: 'gemini-3.5-flash'      },
  'application-cover-letter':  { claude: 'claude-sonnet-4-6',         gemini: 'gemini-3.5-flash'      },
  'text-polish':               { claude: 'claude-haiku-4-5-20251001', gemini: 'gemini-3.1-flash-lite' },
  // Default — used when a caller forgets to pass `task`. Logged as a warning
  // below so we notice unmapped sites; tuned to a safe-middle.
  'default':                   { claude: 'claude-sonnet-4-6',         gemini: 'gemini-3.5-flash'      },
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
  'page-status-classify':      512,   // 5-way enum + one sentence
  'resume-parse':              4096,  // full structured profile
  // Career-file extract reproduces a whole document as faithful text, so it
  // scales with the source. Sized generously: a truncated transcription
  // silently DROPS the candidate's career history and weakens everything
  // downstream (queries, scoring, the generated résumé). Caps are billed on
  // actual output, so the headroom is free insurance, not a cost.
  'career-file-extract':       16384,
  // Gemini 2.5 Flash (the active model for this task) engages thinking which
  // eats the same cap as visible output — real-world: thoughts=979, visible=31
  // at cap=1024 truncated the JSON mid-output. 4096 matches resume-parse and
  // gives ~3000 headroom over typical use (3 short query arrays ≈ 500 tokens
  // visible + ~1000 thinking).
  'job-query-generation':      4096,  // 3 query arrays — small JSON, thinking-heavy
  // Job scoring on Gemini 2.5 Flash with thinking: real-world telemetry shows
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
  // Extraction is thinking-heavy AND reproduces most of the input as JSON, so it
  // scales steeply with paste size — a ~45-job paste truncated at the old 10.5k.
  'cover-letter-generation':   2048,  // a paragraph-length letter
  'interview-prep-generation': 2048,  // bulleted prep
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
  'text-polish':               1024,  // light edit
  'default':                   2048,
};

function resolveTask(task) {
  if (!task || !TASK_MODELS[task]) {
    logger.warn(`[LLM] Unmapped task='${task}', using 'default' (Sonnet 4.6 / Flash, 2048 max_tokens). Add it to TASK_MODELS.`);
    return 'default';
  }
  return task;
}

function pickModel(provider, task) {
  const t = resolveTask(task);
  return TASK_MODELS[t][provider] || TASK_MODELS['default'][provider];
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
  try {
    if (settings.provider === 'claude') {
      const raw = await callClaudeText(prompt, model, settings.anthropicApiKey, signal, { maxTokens: maxTok, formulaSeed, expectJson: true, responseSchema, cachedPrefix, task });
      if (meta) meta.model = model;
      return parseGeminiJSON(raw);
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
    try { parsed[customId] = parseGeminiJSON(r.text); }
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
  const { signal, task, hints, grounding } = normalizeOpts(opts);
  const meta     = (opts.meta && typeof opts.meta === 'object') ? opts.meta : null;
  const settings = getAISettings();
  const provider = settings.provider === 'claude' ? 'claude' : 'gemini';
  const model    = pickModel(provider, task);
  const { cap: maxTok, seed: formulaSeed } = pickMaxTokens(task, { promptLength: prompt?.length || 0, ...hints });
  try {
    if (provider === 'claude') {
      const raw = await callClaudeText(prompt, model, settings.anthropicApiKey, signal, { maxTokens: maxTok, formulaSeed, expectJson: false, grounding, task });
      if (meta) meta.model = model;
      return raw;
    }
    return await callGeminiTextRaw(prompt, settings.geminiApiKey, model, signal, { maxOutputTokens: maxTok, formulaSeed, grounding, task, meta });
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
  try {
    if (settings.provider === 'claude') {
      const raw = await callClaudeVision(imagePaths, prompt, model, settings.anthropicApiKey, signal, { maxTokens: maxTok, formulaSeed, expectJson: true, responseSchema, task });
      if (meta) meta.model = model;
      return parseGeminiJSON(raw);
    }
    return await callGeminiVision(imagePaths, prompt, settings.geminiApiKey, model, signal, { maxOutputTokens: maxTok, formulaSeed, responseSchema, task, meta });
  } catch (err) {
    throw enhanceLLMError(err, settings.provider);
  }
}

export async function callLLMDocument(filePath, prompt, opts = {}) {
  const { signal, task, hints, responseSchema } = normalizeOpts(opts);
  const settings = getAISettings();
  const model    = pickModel(settings.provider === 'claude' ? 'claude' : 'gemini', task);
  const { cap: maxTok, seed: formulaSeed } = pickMaxTokens(task, { promptLength: prompt?.length || 0, ...hints });
  try {
    if (settings.provider === 'claude') {
      const raw = await callClaudeDocument(filePath, prompt, model, settings.anthropicApiKey, signal, { maxTokens: maxTok, formulaSeed, expectJson: true, responseSchema, task });
      return parseGeminiJSON(raw);
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
  // If the error message indicates a rate limit or exhaustion, mark it as RATE_LIMIT
  // so the frontend can catch it and display the model selector.
  const msg = error.message?.toLowerCase() || '';
  if (
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
