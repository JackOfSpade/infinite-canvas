/**
 * Claude models this app uses across every task — the pinned FLOOR
 * (MODEL_FLOOR) plus this registry's fallback metadata (context window / max
 * output) for whichever id ends up serving a call, mirroring geminiModels.js.
 *
 * Unlike Gemini's fallback CASCADE (a whole tier of roughly-equivalent
 * free-tier models retried in order), Claude tasks explicitly pick ONE
 * specific model per task (llm.js's TASK_MODELS) — there is no equivalent
 * multi-model fallback chain here. That's a deliberate product asymmetry
 * (Gemini's free tier genuinely needs quota juggling; Claude's paid API
 * doesn't), not an oversight — see the code-quality audit's 6.3-c.
 *
 * This registry is no longer the sole source of a Claude task's model id.
 * llm.js's TASK_MODELS holds FAMILY TOKENS (CLAUDE_FAMILY.OPUS/.SONNET/.HAIKU
 * — see modelResolver.js), resolved at call time against Anthropic's live
 * Models API, newest-first, gated on capability and never older than
 * MODEL_FLOOR below. This registry still matters for two things: (1)
 * MODEL_FLOOR itself — the pinned safety net a résumé must never fail to
 * generate without, even if model discovery is unreachable — and (2)
 * context-window/max-output fallback metadata (tokenWindow.js's modelMeta())
 * for a model id the live API hasn't (yet) reported numbers for. Every
 * consumer that needs a Claude model id or its token-window metadata
 * (llm.js TASK_MODELS, claude.js's availability-probe list,
 * tokenWindow.js's per-model budget table, gemini.js's cross-provider
 * fallback call) still imports from this ONE place instead of retyping the
 * literal string — previously duplicated ~24x across those files with a
 * "KEEP IN SYNC" comment as the only real guard, and an unrecognized model id
 * silently fell back to a conservative 200K context window rather than
 * erroring, so a forgotten sync would quietly under-budget instead of
 * surfacing the drift. See modelResolver.js's module doc for the full
 * resolution story (version floor, capability gate, Fable/Mythos exclusion,
 * prompt-cache-stability guard).
 *
 * Context windows verified against Anthropic's official docs (Aug 2026):
 * Opus 5 and Sonnet 5 are natively 1M on the Claude API (no beta header
 * needed); Haiku 4.5 is 200K. These are FLOOR numbers — claudeModelMetaFor()
 * (modelResolver.js) supersedes them at runtime with live
 * max_input_tokens/max_tokens whenever the Models API has reported them for
 * the resolved id (tokenWindow.js's modelMeta() checks the live value first).
 *
 * Ordered workhorse → app-gen → light — CLAUDE_MODEL_IDS below (and the
 * availability probe that iterates it) preserves this order for consistent
 * Settings-panel display.
 */

// The pinned safety net: never resolve OLDER than these ids, and fall back to
// them outright when the Models API is unreachable or no key is set. Bump
// opportunistically as Anthropic ships new generations — it's a floor, not
// the source of truth (the resolver is).
export const MODEL_FLOOR = Object.freeze({
  // FABLE is Anthropic's top tier and is NEVER auto-adopted — it only ever
  // serves when the user explicitly selects it in Settings. It costs ~2x Opus
  // ($10/$50 vs $5/$25 per MTok), which is exactly why it must stay opt-in: the
  // resolver's family matching excludes fable/mythos from OPUS/SONNET/HAIKU so
  // a new Fable generation can never silently become "the latest Opus".
  FABLE: 'claude-fable-5',
  OPUS: 'claude-opus-5',
  SONNET: 'claude-sonnet-5',
  HAIKU: 'claude-haiku-4-5',
});

export const CLAUDE_MODEL_REGISTRY = Object.freeze([
  {
    id: MODEL_FLOOR.SONNET,
    tier: 'sonnet',
    contextWindow: 1000000,
    maxOutput: 64000,
    // job scoring/bucketing, resume-parse, query-gen, vision, price-synthesis, company-research
  },
  {
    id: MODEL_FLOOR.OPUS,
    tier: 'opus',
    contextWindow: 1000000,
    maxOutput: 128000,
    // application résumé + cover-letter generation, achievement mining
  },
  {
    id: MODEL_FLOOR.HAIKU,
    tier: 'haiku',
    contextWindow: 200000,
    maxOutput: 64000,
    // platform-fit, page-status, text-polish
  },
]);

const MODEL_BY_ID = new Map(CLAUDE_MODEL_REGISTRY.map((entry) => [entry.id, entry]));

/** Every Claude model id this app uses, in registry order. */
export const CLAUDE_MODEL_IDS = Object.freeze(CLAUDE_MODEL_REGISTRY.map(({ id }) => id));

/** Resolve a model id to its registry entry, or null if unrecognized. */
export function getClaudeModelInfo(model) {
  return MODEL_BY_ID.get(model) || null;
}
