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
    // These are state/ownership outcomes, not interactive browser challenges.
    // Retrying the same card cannot make the current run checkpoint appear or
    // make a stale snapshot belong to this run; wait for final warning resync
    // or start a fresh search instead.
    'description-recovery-not-ready',
    'description-recovery-snapshot-stale',
    'description-recovery-snapshot-unavailable',
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

/**
 * Reconcile source actions made while a multi-source search is still running
 * with the backend's final warning list. A null override is an explicit Skip
 * or a clean successful resolve; a warning override is the latest state from a
 * successful partial resolve. Failed attempts deliberately create no override:
 * the backend's final warning is still authoritative in that case.
 */
export function reconcileJobSourceWarnings(warnings, sourceWarningOverrides) {
  const list = Array.isArray(warnings) ? warnings : [];
  if (!(sourceWarningOverrides instanceof Map) || sourceWarningOverrides.size === 0) return list;

  const reconciled = [];
  const overriddenSourceIds = new Set();
  for (const warning of list) {
    const sourceId = warning?.sourceId;
    if (!sourceId || !sourceWarningOverrides.has(sourceId)) {
      reconciled.push(warning);
      continue;
    }
    // A source can emit more than one final warning. Its newest successful
    // resolve result is a source-level replacement, so include it only once.
    if (overriddenSourceIds.has(sourceId)) continue;
    overriddenSourceIds.add(sourceId);
    const override = sourceWarningOverrides.get(sourceId);
    if (override) reconciled.push({ ...warning, ...override, sourceId });
  }

  // A successful partial resolve can surface a new warning that the in-flight
  // backend search never observed. Retain it rather than losing the card's
  // current actionable state when that search completes.
  for (const [sourceId, override] of sourceWarningOverrides) {
    if (override && !overriddenSourceIds.has(sourceId)) {
      reconciled.push({ ...override, sourceId });
    }
  }
  return reconciled;
}

/**
 * Source-card resolves mutate a run-owned recovery snapshot. They are safe only
 * after the hub has finished gathering/checkpointing its current search.
 */
export function isJobSourceResolveBusyHubState(hubState) {
  return [
    'queued',
    'parsing',
    'querying',
    'interpreting-preferences',
    'searching',
    'scoring',
    'scoring-batch',
    'evaluating-preferences',
  ].includes(hubState);
}

const DESCRIPTION_RECOVERY_SOURCE_IDS = new Set(['google', 'linkedin', 'glassdoor', 'ziprecruiter']);

export function isDescriptionRecoverySourceWarning(warning) {
  return DESCRIPTION_RECOVERY_SOURCE_IDS.has(warning?.sourceId);
}

/**
 * A failed checkpoint write must never leave a card pointing at an older run's
 * recovery snapshot. Keep the source block visible so the person can Skip and
 * score the rows already gathered, but remove every retry affordance.
 */
export function descriptionRecoveryCheckpointWriteFailureWarning(warning) {
  const sourceLabel = warning?.sourceId || 'this source';
  return {
    ...warning,
    code: 'description-recovery-not-ready',
    severity: 'block',
    action: 'none',
    actionLabel: null,
    actionTitle: null,
    url: null,
    resumeState: null,
    openSecondTab: false,
    evidence: `The current-run description-recovery checkpoint for ${sourceLabel} could not be saved, so an older run's data was not used.`,
    suggestion: 'Re-run Search to create a new recovery checkpoint, or Skip to score the jobs already gathered.',
  };
}
