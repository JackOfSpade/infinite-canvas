/**
 * Claude models this app uses across every task — the single source of truth
 * for model ids + their token-window metadata, mirroring geminiModels.js.
 *
 * Unlike Gemini's fallback CASCADE (a whole tier of roughly-equivalent
 * free-tier models retried in order), Claude tasks explicitly pick ONE
 * specific model per task (llm.js's TASK_MODELS) — there is no equivalent
 * multi-model fallback chain here. That's a deliberate product asymmetry
 * (Gemini's free tier genuinely needs quota juggling; Claude's paid API
 * doesn't), not an oversight — see the code-quality audit's 6.3-c.
 *
 * This registry exists so every consumer that needs a Claude model id or its
 * context-window metadata (llm.js TASK_MODELS, claude.js's availability-probe
 * list, tokenWindow.js's per-model budget table, gemini.js's cross-provider
 * fallback call) imports from ONE place instead of retyping the literal
 * string — previously duplicated ~24× across those files with a "KEEP IN
 * SYNC" comment as the only real guard, and an unrecognized model id silently
 * fell back to a conservative 200K context window rather than erroring, so a
 * forgotten sync would quietly under-budget instead of surfacing the drift.
 *
 * Context windows verified against Anthropic's official docs (May 2026):
 * Sonnet 4.6 and Opus 4.8 are natively 1M on the Claude API (no beta header
 * needed); Haiku 4.5 is 200K.
 *
 * Ordered workhorse → app-gen → light — CLAUDE_MODEL_IDS below (and the
 * availability probe that iterates it) preserves this order for consistent
 * Settings-panel display.
 */
export const CLAUDE_MODEL_REGISTRY = Object.freeze([
  {
    id: 'claude-sonnet-4-6',
    tier: 'sonnet',
    contextWindow: 1000000,
    maxOutput: 64000,
    // job scoring/bucketing, resume-parse, query-gen, vision, price-synthesis, company-research
  },
  {
    id: 'claude-opus-4-8',
    tier: 'opus',
    contextWindow: 1000000,
    maxOutput: 128000,
    // application résumé + cover-letter generation
  },
  {
    id: 'claude-haiku-4-5-20251001',
    tier: 'haiku',
    contextWindow: 200000,
    maxOutput: 64000,
    // platform-fit, page-status, text-polish
  },
]);

const MODEL_BY_ID = new Map(CLAUDE_MODEL_REGISTRY.map((entry) => [entry.id, entry]));
const MODEL_BY_TIER = new Map(CLAUDE_MODEL_REGISTRY.map((entry) => [entry.tier, entry]));

/** Every Claude model id this app uses, in registry order. */
export const CLAUDE_MODEL_IDS = Object.freeze(CLAUDE_MODEL_REGISTRY.map(({ id }) => id));

// Named ids for call sites that want a specific tier without retyping the
// literal string — a model rename/version bump only needs to change here.
export const CLAUDE_OPUS = MODEL_BY_TIER.get('opus').id;
export const CLAUDE_SONNET = MODEL_BY_TIER.get('sonnet').id;
export const CLAUDE_HAIKU = MODEL_BY_TIER.get('haiku').id;

/** Resolve a model id to its registry entry, or null if unrecognized. */
export function getClaudeModelInfo(model) {
  return MODEL_BY_ID.get(model) || null;
}
