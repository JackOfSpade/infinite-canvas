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
 * Ordered workhorse → app-gen → light — CLAUDE_MODEL_REGISTRY above (and
 * claudeModelsInUse() in modelResolver.js, which the availability probe
 * iterates) preserves this order for consistent Settings-panel display.
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
    // job scoring/bucketing, resume-parse, query-gen, vision, price-synthesis
  },
  {
    id: MODEL_FLOOR.OPUS,
    tier: 'opus',
    contextWindow: 1000000,
    maxOutput: 128000,
    // Reserved for an explicit high-quality API task when one is introduced.
  },
  {
    id: MODEL_FLOOR.HAIKU,
    tier: 'haiku',
    contextWindow: 200000,
    maxOutput: 64000,
    // platform-fit, page-status, text-polish
  },
]);

// Claude 4.6+ (including the current Claude 5 family) supports adaptive
// thinking.  `output_config.effort` is the documented control for its depth;
// medium is the app-wide policy.  Haiku 4.5 predates that control, so it needs
// extended thinking's numeric budget instead.  4,096 is our stable
// medium-equivalent allocation: enough room to reason, while leaving output
// headroom under the 5,120-token minimum enforced below.
export const CLAUDE_MEDIUM_MANUAL_THINKING_BUDGET = 4096;
const ADAPTIVE_THINKING_MODEL = /^claude-(?:opus|sonnet|haiku|fable|mythos)-(?:4-(?:[6-9]|\d\d)|[5-9]|\d\d)(?:-|$)/i;

/**
 * The default reasoning controls for a Claude model.
 *
 * Modern models receive explicit adaptive thinking and medium effort.  Older
 * Claude models that remain in use (currently Haiku 4.5) do not accept the
 * effort field, so enable their manual extended-thinking mode at the closest
 * consistent budget instead.  Unknown non-Claude ids deliberately receive no
 * provider options; that keeps this pure request helper safe in generic tests.
 */
export function getClaudeDefaultReasoningConfig(model) {
  const id = String(model || '');
  if (!/^claude-/i.test(id)) return {};
  if (ADAPTIVE_THINKING_MODEL.test(id)) {
    return {
      thinking: { type: 'adaptive' },
      outputConfig: { effort: 'medium' },
    };
  }
  return {
    thinking: { type: 'enabled', budget_tokens: CLAUDE_MEDIUM_MANUAL_THINKING_BUDGET },
  };
}

/**
 * Manual extended thinking requires `budget_tokens < max_tokens`.  Raise only
 * legacy/manual-model requests to preserve the requested medium thinking
 * budget plus a modest visible-answer allowance.  Modern adaptive-thinking
 * models retain each task's calibrated cap unchanged.
 */
export function claudeReasoningMaxTokens(model, maxTokens) {
  const requested = Math.max(1, Number(maxTokens) || 0);
  const { thinking } = getClaudeDefaultReasoningConfig(model);
  return thinking?.type === 'enabled'
    ? Math.max(requested, CLAUDE_MEDIUM_MANUAL_THINKING_BUDGET + 1024)
    : requested;
}
