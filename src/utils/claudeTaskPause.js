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

// The limit kinds Claude reports, as the one or two words the dock and the
// accounts panel put in a headline or a "Limited until …" line.
const LIMIT_LABELS = Object.freeze({
  five_hour: '5-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly Opus',
  seven_day_sonnet: 'weekly Sonnet',
  seven_day_overage_included: 'extra usage',
  overage: 'extra usage',
});

/** Pure: short label for a limitType; unknown or missing types read as plain usage. */
export function claudeLimitLabel(limitType) {
  return Object.hasOwn(LIMIT_LABELS, limitType) ? LIMIT_LABELS[limitType] : 'usage';
}

const LIMIT_HEADLINES = Object.freeze({
  five_hour: 'Claude 5-hour limit reached',
  seven_day: 'Claude weekly limit reached',
  seven_day_opus: 'Claude weekly Opus limit reached',
  seven_day_sonnet: 'Claude weekly Sonnet limit reached',
  seven_day_overage_included: 'Claude extra usage limit reached',
  overage: 'Claude extra usage limit reached',
});

/** Pure: 'pro' -> 'Pro', 'max' -> 'Max'; null when Claude did not say. */
export function claudePlanLabel(subscriptionType) {
  if (typeof subscriptionType !== 'string' || !subscriptionType) return null;
  return subscriptionType.slice(0, 40).charAt(0).toUpperCase() + subscriptionType.slice(0, 40).slice(1);
}

const clockTime = at => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const emailOf = account => (typeof account?.email === 'string' && account.email ? account.email : null);
const countOf = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);

/** Pure: 'Signed in as a@b.c (Pro).' — null when Claude did not name the account. */
function signInSentence(account) {
  const email = emailOf(account);
  if (!email) return null;
  const plan = claudePlanLabel(account?.subscriptionType);
  return plan ? `Signed in as ${email} (${plan}).` : `Signed in as ${email}.`;
}

/**
 * The notice while a usage limit holds every Claude call: what is safe, when
 * work continues, and which account (or how many) is actually blocked.
 */
export function claudeUsageLimitNotice(usageLimit, accounts = []) {
  if (!usageLimit) return null;
  const list = Array.isArray(accounts) ? accounts.filter(account => account && typeof account === 'object') : [];
  const accountCount = countOf(usageLimit.accountCount) ?? list.length;
  const signedIn = list.filter(account => emailOf(account));
  const saved = usageLimit.knownReset
    ? `All finished work is saved and nothing was lost. Work continues by itself when usage resets, around ${clockTime(usageLimit.resumeAt)}.`
    : `All finished work is saved and nothing was lost. Claude did not say when usage resets, so the app tries again around ${clockTime(usageLimit.resumeAt)}.`;
  const blocked = accountCount >= 2
    ? `All ${accountCount} signed-in Claude accounts are at their limit.`
    : (signedIn.length === 1 ? signInSentence(signedIn[0]) : null);
  return {
    headline: Object.hasOwn(LIMIT_HEADLINES, usageLimit.limitType) ? LIMIT_HEADLINES[usageLimit.limitType] : 'Claude usage limit reached',
    reason: [saved, blocked, 'Add another Claude account to keep working now.'].filter(Boolean).join(' '),
  };
}
