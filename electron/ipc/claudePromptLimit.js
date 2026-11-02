// How large a prompt Claude Code can accept. Official limits, confirmed on
// 2026-11-02 from the CLI's own modelUsage report: Opus, Sonnet and Haiku all
// run with a 1,000,000-token window and a 128,000-token output limit.
export const CLAUDE_CONTEXT_WINDOW_TOKENS = 1_000_000;
export const CLAUDE_OUTPUT_TOKENS = 128_000;
// The CLI's own system prompt took about 16,000 tokens when measured. The rest
// of this reserve covers its growth, our appended instructions and any photos.
const CLAUDE_CODE_OVERHEAD_TOKENS = 24_000;
// Every call asks for the full output limit, so all of it is reserved.
export const CLAUDE_PROMPT_TOKEN_BUDGET = CLAUDE_CONTEXT_WINDOW_TOKENS - CLAUDE_OUTPUT_TOKENS - CLAUDE_CODE_OVERHEAD_TOKENS;

// Claude Code has no local token counter, so this estimates from UTF-8 bytes.
// The ratio errs high: a prompt near the limit should split rather than fail,
// and bytes keep non-Latin text, which uses far more tokens per character, safe.
const UTF8_BYTES_PER_TOKEN = 2.5;

export const CLAUDE_PROMPT_TOO_LONG = 'CLAUDE_PROMPT_TOO_LONG';

export function estimateClaudePromptTokens(...parts) {
  const bytes = parts.reduce((sum, part) => sum + (typeof part === 'string' ? Buffer.byteLength(part, 'utf8') : 0), 0);
  return Math.ceil(bytes / UTF8_BYTES_PER_TOKEN);
}

export function claudePromptTooLongMessage(tokens) {
  return `This AI request is too large for Claude: about ${tokens.toLocaleString('en-US')} tokens, and the limit is ${CLAUDE_PROMPT_TOKEN_BUDGET.toLocaleString('en-US')}.`;
}

/** Throw before a request Claude could only refuse. */
export function assertClaudePromptFits(...parts) {
  const tokens = estimateClaudePromptTokens(...parts);
  if (tokens <= CLAUDE_PROMPT_TOKEN_BUDGET) return;
  throw Object.assign(new Error(claudePromptTooLongMessage(tokens)), { code: CLAUDE_PROMPT_TOO_LONG });
}
