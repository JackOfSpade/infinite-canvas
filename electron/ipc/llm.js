import { getAISettings } from './settings.js';
import { callGeminiText, callGeminiVision, callGeminiDocument, parseGeminiJSON } from './gemini.js';
import { callClaudeText, callClaudeVision, callClaudeDocument } from './claude.js';
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
 *     job scoring, cover letters, interview prep — anywhere quality
 *     compounds or the output is user-facing.
 *   - Haiku 4.5: page status classify, query gen, text polish — short
 *     structured outputs where Sonnet adds no value (3x cheaper).
 *   - Gemini Flash: matches Sonnet's tasks (good enough, 10x cheaper).
 *   - Gemini Flash-Lite: matches Haiku's tasks (3x cheaper than Flash).
 *   - Opus: not used. 5x input / 1.67x output over Sonnet with no current
 *     task needing the delta. Add a row here if a future agentic flow
 *     actually justifies it.
 */
const TASK_MODELS = {
  'vision-product-analysis':   { claude: 'claude-sonnet-4-6',         gemini: 'gemini-2.5-flash'      },
  'price-synthesis':           { claude: 'claude-sonnet-4-6',         gemini: 'gemini-2.5-flash'      },
  'platform-fit-assessment':   { claude: 'claude-haiku-4-5-20251001', gemini: 'gemini-2.5-flash-lite' },
  'page-status-classify':      { claude: 'claude-haiku-4-5-20251001', gemini: 'gemini-2.5-flash-lite' },
  'resume-parse':              { claude: 'claude-sonnet-4-6',         gemini: 'gemini-2.5-flash'      },
  'job-query-generation':      { claude: 'claude-haiku-4-5-20251001', gemini: 'gemini-2.5-flash'      },
  'job-scoring':               { claude: 'claude-sonnet-4-6',         gemini: 'gemini-2.5-flash'      },
  'job-bucketing':             { claude: 'claude-haiku-4-5-20251001', gemini: 'gemini-2.5-flash'      },
  'cover-letter-generation':   { claude: 'claude-sonnet-4-6',         gemini: 'gemini-2.5-flash'      },
  'interview-prep-generation': { claude: 'claude-sonnet-4-6',         gemini: 'gemini-2.5-flash'      },
  'text-polish':               { claude: 'claude-haiku-4-5-20251001', gemini: 'gemini-2.5-flash-lite' },
  // Default — used when a caller forgets to pass `task`. Logged as a warning
  // below so we notice unmapped sites; tuned to a safe-middle.
  'default':                   { claude: 'claude-sonnet-4-6',         gemini: 'gemini-2.5-flash'      },
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
  // Gemini 2.5 Flash thinks against this same cap (thoughtsTokenCount counts
  // toward MAX_TOKENS). Thinking budget scales roughly linearly with comp
  // count — the new anchor/adjusted/bound classification prompt asks the
  // model to reason about each item individually. Real-world calibration:
  // 90 comps → ~7861 thinking + ~317 visible tokens, blew the prior
  // static 8192 cap.
  //
  // Formula: ~100 thinking tokens per comp + ~3000 visible budget for the
  // JSON output (pricing + match_quality + comp_breakdown + justification +
  // recommended_platforms). Capped at 24576 so a pathological input can't
  // request runaway billing.
  'price-synthesis':           ({ itemCount = 40 } = {}) =>
    Math.min(24576, 3000 + itemCount * 100),
  'platform-fit-assessment':   1024,  // per-platform fit verdict + short reason
  'page-status-classify':      512,   // 5-way enum + one sentence
  'resume-parse':              4096,  // full structured profile
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
  // truncation. New formula: 2500 base + 300/item gives 15→7000, 50→17500,
  // capped at 24576 so a pathological batch can't request runaway billing.
  'job-scoring':               ({ itemCount = 10 } = {}) =>
    Math.min(24576, 2500 + itemCount * 300),
  // Bucketing reasons over salaries per category — thinking-heavy (the model
  // weighs distributions) but visible output is small (~50 tokens per bucket
  // × ~10 buckets total = ~500). Static 6144 absorbs typical use; scales OK
  // up to ~100 jobs.
  'job-bucketing':             6144,
  'cover-letter-generation':   2048,  // a paragraph-length letter
  'interview-prep-generation': 2048,  // bulleted prep
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
  const entry = TASK_MAX_TOKENS[resolveTask(task)] ?? TASK_MAX_TOKENS['default'];
  return typeof entry === 'function' ? entry(hints) : entry;
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
  const settings = getAISettings();
  const model    = pickModel(settings.provider === 'claude' ? 'claude' : 'gemini', task);
  const fullLen  = (prompt?.length || 0) + (cachedPrefix?.length || 0);
  const maxTok   = pickMaxTokens(task, { promptLength: fullLen, ...hints });
  try {
    if (settings.provider === 'claude') {
      const raw = await callClaudeText(prompt, model, settings.anthropicApiKey, signal, { maxTokens: maxTok, expectJson: true, responseSchema, cachedPrefix });
      return parseGeminiJSON(raw);
    }
    // Gemini: prepend prefix into the prompt; implicit prefix caching on 2.5
    // models picks up the repeated content automatically.
    const merged = cachedPrefix ? `${cachedPrefix}\n\n${prompt}` : prompt;
    return await callGeminiText(merged, settings.geminiApiKey, model, signal, { maxOutputTokens: maxTok, responseSchema });
  } catch (err) {
    throw enhanceLLMError(err, settings.provider);
  }
}

export async function callLLMVision(imagePaths, prompt, opts = {}) {
  const { signal, task, hints, responseSchema } = normalizeOpts(opts);
  const settings = getAISettings();
  const model    = pickModel(settings.provider === 'claude' ? 'claude' : 'gemini', task);
  // photoCount feeds the dynamic sizing function for tasks like
  // vision-product-analysis. Caller-supplied hints win on conflict so a future
  // call site can override when it knows better than the default heuristic.
  const maxTok   = pickMaxTokens(task, { photoCount: imagePaths?.length || 0, promptLength: prompt?.length || 0, ...hints });
  try {
    if (settings.provider === 'claude') {
      const raw = await callClaudeVision(imagePaths, prompt, model, settings.anthropicApiKey, signal, { maxTokens: maxTok, expectJson: true, responseSchema });
      return parseGeminiJSON(raw);
    }
    return await callGeminiVision(imagePaths, prompt, settings.geminiApiKey, model, signal, { maxOutputTokens: maxTok, responseSchema });
  } catch (err) {
    throw enhanceLLMError(err, settings.provider);
  }
}

export async function callLLMDocument(filePath, prompt, opts = {}) {
  const { signal, task, hints, responseSchema } = normalizeOpts(opts);
  const settings = getAISettings();
  const model    = pickModel(settings.provider === 'claude' ? 'claude' : 'gemini', task);
  const maxTok   = pickMaxTokens(task, { promptLength: prompt?.length || 0, ...hints });
  try {
    if (settings.provider === 'claude') {
      const raw = await callClaudeDocument(filePath, prompt, model, settings.anthropicApiKey, signal, { maxTokens: maxTok, expectJson: true, responseSchema });
      return parseGeminiJSON(raw);
    }
    return await callGeminiDocument(filePath, prompt, settings.geminiApiKey, model, signal, { maxOutputTokens: maxTok, responseSchema });
  } catch (err) {
    throw enhanceLLMError(err, settings.provider);
  }
}

// Back-compat shim: old call sites passed `signal` as the second positional.
// Detect a plain AbortSignal and wrap it as `{ signal, task: undefined }`.
// New call sites should pass `{ signal, task }`.
function normalizeOpts(opts) {
  if (opts && typeof opts === 'object' && (opts.task !== undefined || opts.signal !== undefined || opts.hints !== undefined || opts.responseSchema !== undefined || opts.cachedPrefix !== undefined || Object.keys(opts).length === 0)) {
    return { signal: opts.signal, task: opts.task, hints: opts.hints || {}, responseSchema: opts.responseSchema, cachedPrefix: opts.cachedPrefix };
  }
  // Anything else (a raw AbortSignal, undefined, etc.) → treat as signal.
  return { signal: opts, task: undefined, hints: {}, responseSchema: undefined, cachedPrefix: undefined };
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
