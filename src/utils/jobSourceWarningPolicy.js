/**
 * Whether a job-source warning must pause the pipeline for a user decision.
 *
 * Most source warnings describe partial-but-usable results and must not spend
 * minutes holding otherwise-valid jobs before scoring. Hard blocks/paste flows
 * do pause, as does LinkedIn's guest limit because its recovery can materially
 * improve the descriptions sent to scoring.
 */
export function isJobSourceWarningGating(warning) {
  return warning?.severity === 'block'
    || warning?.severity === 'paste'
    || warning?.code === 'linkedin-rate-limited';
}

/**
 * The source-card action is a real Skip only for a gating warning. For a
 * partial-data warning, it merely acknowledges and hides the diagnostic.
 */
export function jobSourceWarningAction(warning) {
  return isJobSourceWarningGating(warning) ? 'skip' : 'dismiss';
}

/**
 * Whether a source warning represents something the resolver can actually
 * change in its shared-profile Chrome window. A terminal hard block has no
 * checkbox, captcha, or login control, so offering Solve only creates an
 * open/auto-close/retry loop while the IP/session restriction remains active.
 * Keep the code allow-list here as well as honoring the explicit action field
 * so older persisted warnings get the corrected behavior after an upgrade.
 */
export function canAttemptJobSourceResolve(warning) {
  if (!warning || warning.action === 'none') return false;
  return ![
    'cloudflare-hard-block',
    'description-detail-hard-block',
  ].includes(warning.code);
}

/**
 * Drop stale backend warnings for sources the user already handled while the
 * multi-source search was still in flight.
 */
export function filterHandledJobSourceWarnings(warnings, handledSourceIds) {
  const list = Array.isArray(warnings) ? warnings : [];
  if (!handledSourceIds || handledSourceIds.size === 0) return list;
  return list.filter(warning => !handledSourceIds.has(warning?.sourceId));
}
