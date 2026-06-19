/**
 * Context-window math + per-model metadata for LLM calls — pure and
 * dependency-free so the budget logic is unit-testable without booting Electron
 * or any provider SDK.
 *
 * Every LLM call shares one budget between the prompt (input) and the reserved
 * output (`max_tokens`): roughly `input + reserved_output ≤ context_window`.
 * Before each call we preflight the prompt against the model that will actually
 * serve it (see checkPromptFits in llm.js); list-payload calls (job scoring)
 * additionally split when a batch won't fit (the scoreBatch preflight in
 * jobs.js). The free network token-count itself lives in claude.js / gemini.js;
 * this module owns the model table, the local estimate, and the split planning.
 */

// Per-model context window (input+output budget) and max output tokens.
// Verified against the providers' official docs (May 2026):
//   • Anthropic — Sonnet 4.6 and Opus 4.8 are NATIVELY 1M on the Claude API (no
//     beta header); Haiku 4.5 is 200K. "maxOutput" is the synchronous Messages
//     API ceiling. (Claude 4.5+ overflow is graceful: input+max_tokens over the
//     window doesn't 400 — generation stops with `model_context_window_exceeded`.)
//   • Google — every general-purpose model in our cascade is 1,048,576 input /
//     65,536 output. (Gemini's input and output limits are technically separate,
//     not one shared budget; we still subtract output from the window, which is
//     safely conservative — it costs ~2% of a 1M window.)
// Keep ids in sync with llm.js TASK_MODELS and gemini.js GEMINI_MODEL_FALLBACKS.
const MODEL_METADATA = {
  'claude-opus-4-8':           { contextWindow: 1000000, maxOutput: 128000, provider: 'claude' },
  'claude-sonnet-4-6':         { contextWindow: 1000000, maxOutput: 64000,  provider: 'claude' },
  'claude-haiku-4-5-20251001': { contextWindow: 200000,  maxOutput: 64000,  provider: 'claude' },
  'gemini-3.5-flash':          { contextWindow: 1048576, maxOutput: 65536,  provider: 'gemini' },
  'gemini-3-flash-preview':    { contextWindow: 1048576, maxOutput: 65536,  provider: 'gemini' },
  'gemini-3.1-flash-lite':     { contextWindow: 1048576, maxOutput: 65536,  provider: 'gemini' },
  'gemini-2.5-flash':          { contextWindow: 1048576, maxOutput: 65536,  provider: 'gemini' },
  'gemini-2.5-flash-lite':     { contextWindow: 1048576, maxOutput: 65536,  provider: 'gemini' },
};

// Conservative family fallbacks for a model id not (yet) in the table. Claude
// falls back to the SMALLER 200K default (a new Claude model might not be 1M, so
// under-estimating the window is the safe direction — it can only over-split,
// never wave an oversized prompt through). Gemini falls back to the 1M family norm.
const FAMILY_FALLBACK = {
  claude: { contextWindow: 200000,  maxOutput: 64000 },
  gemini: { contextWindow: 1048576, maxOutput: 65536 },
};
const DEFAULT_META = { contextWindow: 200000, maxOutput: 64000 };

/** Resolve a model id to { contextWindow, maxOutput, provider }. Never throws. */
export function modelMeta(model) {
  if (model && MODEL_METADATA[model]) return MODEL_METADATA[model];
  if (typeof model === 'string') {
    if (/^gemini/i.test(model)) return { ...FAMILY_FALLBACK.gemini, provider: 'gemini' };
    if (/^claude/i.test(model)) return { ...FAMILY_FALLBACK.claude, provider: 'claude' };
  }
  return { ...DEFAULT_META, provider: 'claude' };
}

/** Context window (input+output budget) for a model id. */
export function contextWindowForModel(model) {
  return modelMeta(model).contextWindow;
}

/** Max output tokens a model can emit in one response. */
export function maxOutputForModel(model) {
  return modelMeta(model).maxOutput;
}

// Conservative chars→tokens ratio for the cheap local pre-estimate. Real text is
// ~3.5–4 chars/token (denser for JSON); 2.5 deliberately OVER-counts so the local
// short-circuit only fires when we're genuinely, comfortably under budget —
// otherwise we fall through to the authoritative (free) count API at the boundary.
// An over-estimate can never wave through an oversized prompt; it only triggers a
// (free) network count slightly earlier than strictly necessary.
export const LOCAL_CHARS_PER_TOKEN = 2.5;

/** Cheap, network-free upper-bound token estimate from a character count. */
export function estimateTokensFromChars(chars) {
  return Math.ceil(Math.max(0, Number(chars) || 0) / LOCAL_CHARS_PER_TOKEN);
}

/**
 * Does a prompt of `promptTokens` leave room for the reserved output inside the
 * model's context window, after a safety margin? `requestedOutput` is the
 * max_tokens we intend to ask for; it's clamped to the model's own max output.
 * The margin (≥2048, ~1.5% of the window) absorbs count-estimate drift (the
 * provider count is itself "an estimate") plus per-message framing.
 * @returns {{ fits:boolean, budget:number, safety:number, reservedOutput:number, contextWindow:number }}
 */
export function assessPromptFit({ contextWindow, modelMaxOutput, requestedOutput, promptTokens }) {
  const window = Math.max(0, Number(contextWindow) || 0);
  const reservedOutput = Math.min(
    Math.max(0, Number(requestedOutput) || 0),
    Math.max(0, Number(modelMaxOutput) || Infinity),
  );
  const safety = Math.max(2048, Math.ceil(window * 0.015));
  const budget = Math.max(0, window - reservedOutput - safety);
  return { fits: (Number(promptTokens) || 0) <= budget, budget, safety, reservedOutput, contextWindow: window };
}

/**
 * The pure model of the scorer's proactive batch splitting. Given a list of
 * items and a `fits(items)` predicate (true when that group fits the window
 * alongside its reserved output), recursively HALVE any group that doesn't fit
 * and return the resulting chunks in original order (flattening the result
 * yields the input).
 *
 * Halving — rather than proportional slicing — isolates a single oversized item
 * into its own 1-element chunk instead of dragging a whole slice down with it.
 * A size-1 group that still doesn't fit is returned as-is: it can't be split
 * further, so the caller handles that atomic case (it never occurs in practice —
 * one job is ~thousands of tokens against a 200K+ window).
 *
 * scoreBatch in jobs.js mirrors this exact recursion, interleaving the (async)
 * scoring call at each leaf; this sync version exists so the split arithmetic is
 * testable in isolation.
 */
export function planSplits(items, fits) {
  const arr = Array.isArray(items) ? items : [];
  if (arr.length <= 1 || fits(arr)) return [arr];
  const mid = Math.ceil(arr.length / 2);
  return [...planSplits(arr.slice(0, mid), fits), ...planSplits(arr.slice(mid), fits)];
}
