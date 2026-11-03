// What the dock says when Claude, which answers every AI task, cannot run.
// Only the three stops the worker waits out are shown; any other failure is
// retried quietly and is not worth a notice.
export const CLAUDE_PAUSE_COPY = Object.freeze({
  headline: 'AI work is paused and will resume',
  reasons: Object.freeze({
    CLAUDE_USAGE_LIMIT: 'Claude has reached its usage limit. Work continues when the limit resets.',
    CLAUDE_NOT_SIGNED_IN: 'Claude Code is not signed in. Run claude in a terminal and sign in with your Claude subscription; work continues on its own.',
    CLAUDE_CLI_MISSING: 'Claude Code is not installed or not on PATH. Install it and sign in; work continues on its own.',
  }),
});

/** The notice for a worker status, or null when nothing is held up. */
export function claudePauseNotice(status) {
  if (!status || status.paused !== true) return null;
  const reason = Object.hasOwn(CLAUDE_PAUSE_COPY.reasons, status.pauseCode) ? CLAUDE_PAUSE_COPY.reasons[status.pauseCode] : null;
  return reason ? { headline: CLAUDE_PAUSE_COPY.headline, reason } : null;
}

const clockTime = at => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** The notice while a usage limit holds every Claude call: what is safe, and when work continues. */
export function claudeUsageLimitNotice(usageLimit) {
  if (!usageLimit) return null;
  return {
    headline: 'Claude usage limit reached',
    reason: `All finished work is saved and nothing was lost. ${usageLimit.knownReset
      ? `Work continues by itself when usage resets, around ${clockTime(usageLimit.resumeAt)}.`
      : `Claude did not say when usage resets, so the app tries again around ${clockTime(usageLimit.resumeAt)}.`}`,
  };
}
