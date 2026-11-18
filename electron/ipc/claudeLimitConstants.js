// Shared by the Claude account, pause and diagnostics modules so the limit
// vocabulary and wait times are defined once.
export const CLAUDE_LIMIT_TYPES = new Set([
  'five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included', 'overage',
]);
// Wait after a reported reset time before a limited account is tried again.
export const CLAUDE_LIMIT_RESET_GRACE_MS = 60_000;
// Wait before probing again when no reset time is known.
export const CLAUDE_LIMIT_PROBE_MS = 10 * 60_000;
