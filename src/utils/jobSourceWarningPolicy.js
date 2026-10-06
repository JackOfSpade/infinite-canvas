import { isTerminalSourceStatus } from './sourceProgress.js';

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
 * Reflect a terminal, actionable source-card warning in the live hub while a
 * multi-source search is still gathering. Source cards consume progress IPC
 * immediately, whereas the hub normally receives its warning list only in the
 * eventual `searchJobs` response. Leaving that gap open made the live card say
 * "blocked" while the hub and diagnostics claimed zero blockers.
 *
 * This is deliberately a provisional source-level projection, not final
 * warning reconciliation: one card has only its current terminal warning,
 * while the backend can return several query-specific warnings for that source.
 * The caller uses it only during `searching`; the final backend list replaces
 * it before the pipeline pauses, scores, or completes.
 *
 * `projectedWarnings` holds only entries that this bridge inserted. That
 * provenance lets a later clear/retry remove the stale live entry without
 * touching a matching warning supplied by another authority (most importantly
 * the eventual backend final list).
 */
const MAX_WARNING_PROJECTION_DEPTH = 16;
const MAX_WARNING_PROJECTION_KEYS = 64;
const MAX_WARNING_PROJECTION_STRING_LENGTH = 4_000;

function warningProjectionSignature(warning) {
  // Source-progress warnings are JSON-safe IPC payloads. Still reject a
  // malformed in-memory object instead of letting a cyclic/deep value crash
  // the live hub, and encode every scalar/key unambiguously so delimiter text
  // in evidence cannot make two different warnings compare equal.
  const active = new WeakSet();
  const serialize = (value, depth = 0) => {
    if (depth > MAX_WARNING_PROJECTION_DEPTH) return null;
    if (value === null) return 'null';
    if (typeof value === 'string') {
      return value.length <= MAX_WARNING_PROJECTION_STRING_LENGTH ? `string:${JSON.stringify(value)}` : null;
    }
    if (typeof value === 'boolean') return `boolean:${value}`;
    if (typeof value === 'number') {
      return Number.isFinite(value) ? `number:${Object.is(value, -0) ? '-0' : String(value)}` : null;
    }
    if (typeof value !== 'object') return null;
    if (active.has(value)) return null;
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > MAX_WARNING_PROJECTION_KEYS) return null;
        const items = value.map(item => serialize(item, depth + 1));
        return items.every(Boolean) ? `array:[${items.join(',')}]` : null;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return null;
      const keys = Object.keys(value).sort();
      if (keys.length > MAX_WARNING_PROJECTION_KEYS) return null;
      const entries = keys.map((key) => {
        const encoded = serialize(value[key], depth + 1);
        return encoded ? `${JSON.stringify(key)}=${encoded}` : null;
      });
      return entries.every(Boolean) ? `object:{${entries.join(',')}}` : null;
    } finally {
      active.delete(value);
    }
  };
  try {
    return serialize(warning);
  } catch {
    return null;
  }
}

function isSameWarningProjection(a, b) {
  const aSignature = warningProjectionSignature(a);
  const bSignature = warningProjectionSignature(b);
  return !!aSignature && aSignature === bSignature;
}

function removeOneWarningProjection(warnings, projection) {
  const index = warnings.findIndex(warning => isSameWarningProjection(warning, projection));
  if (index < 0) return warnings;
  return [...warnings.slice(0, index), ...warnings.slice(index + 1)];
}

export function reconcileTerminalJobSourceWarningProjection(
  warnings,
  sourceProgress,
  projectedWarnings = new Map(),
) {
  const current = Array.isArray(warnings) ? warnings : [];
  const prior = projectedWarnings instanceof Map ? projectedWarnings : new Map();
  const sourceIds = new Set([...prior.keys(), ...Object.keys(sourceProgress || {})]);
  const nextProjectedWarnings = new Map();
  let next = current;

  for (const sourceId of sourceIds) {
    const progress = sourceProgress?.[sourceId];
    const warning = progress?.warning;
    const liveWarning = isTerminalSourceStatus(progress?.status) && isJobSourceWarningGating(warning)
      // The progress-map key is the IPC source identity. Do not trust a
      // malformed nested warning to project itself onto a different card/hub.
      ? { ...warning, sourceId }
      : null;
    const priorWarning = prior.get(sourceId) || null;

    // Same terminal outcome, still represented: retain both the warning and
    // its provenance without writing on every progress/render tick.
    if (
      priorWarning
      && liveWarning
      && isSameWarningProjection(priorWarning, liveWarning)
      && next.some(entry => isSameWarningProjection(entry, priorWarning))
    ) {
      nextProjectedWarnings.set(sourceId, priorWarning);
      continue;
    }

    // Clear/retry and changed terminal outcomes retract only the bridge's own
    // entry. Final/backend or unrelated source warnings remain untouched.
    if (priorWarning) next = removeOneWarningProjection(next, priorWarning);
    // Do not copy an untrusted/non-JSON-shaped progress payload into durable
    // hub state. Final backend warnings are preserved in `next` regardless.
    if (!liveWarning || !warningProjectionSignature(liveWarning)) continue;

    // If another authority has already supplied this exact warning, do not
    // claim it as provisional: a later progress clear must not remove it.
    if (next.some(entry => isSameWarningProjection(entry, liveWarning))) continue;
    next = [...next, liveWarning];
    nextProjectedWarnings.set(sourceId, liveWarning);
  }

  return { warnings: next, projectedWarnings: nextProjectedWarnings };
}

/**
 * Select the generation a persisted source-card action is allowed to address.
 *
 * Current cards carry their own `jobRunId`; that token is always authoritative
 * (including a deliberately malformed/null token, which must fail closed).
 * Older saved canvases predate per-card tokens, though. A legacy warning card
 * is still actionable after reload only when the live hub is paused at
 * `sources-ready` for this exact gating source. In that narrowly-proven case
 * the hub's current token is the only recoverable generation to adopt.
 */
export function effectiveJobSourceCardRunId(
  progress,
  persistedProgress,
  hubData,
  sourceId,
) {
  const tokenCandidates = [progress, persistedProgress];
  for (const candidate of tokenCandidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    if (!Object.hasOwn(candidate, 'jobRunId')) continue;
    return typeof candidate.jobRunId === 'string' && candidate.jobRunId
      ? candidate.jobRunId
      : null;
  }
  const hubRunId = typeof hubData?.jobRunId === 'string' && hubData.jobRunId
    ? hubData.jobRunId
    : null;
  const matchesCurrentGate = Array.isArray(hubData?.scrapeWarnings)
    && hubData.scrapeWarnings.some((warning) => (
      warning?.sourceId === sourceId && isJobSourceWarningGating(warning)
    ));
  return hubData?.hubState === 'sources-ready' && hubRunId && matchesCurrentGate
    ? hubRunId
    : null;
}

/**
 * The source-card action is a real Skip only for a gating warning. For a
 * partial-data warning, it merely acknowledges and hides the diagnostic.
 */
export function jobSourceWarningAction(warning) {
  // Some provider blocks are actionable only outside the resolver (for
  // example, a saved crash recovery whose shared browser needs a sign-in).
  // Preserve that explicit action instead of converting it into a generic
  // source retry, which can neither authenticate the account nor resume the
  // durable checkpoint.
  if (warning?.action === 'open-external') return 'open-external';
  if (warning?.action === 'login-platform') return 'login-platform';
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
 * Whether the hub's "Solve all" loop may drive this warning unattended.
 * Login and external-navigation actions are deliberately per-card only: they
 * open a human workflow and do not prove the source has resumed.
 */
export function canAutomaticallyResolveJobSourceWarning(warning) {
  return canAttemptJobSourceResolve(warning)
    && !['open-external', 'login-platform'].includes(jobSourceWarningAction(warning));
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
 *
 * The renderer keeps the hub in `searching` while it performs downstream work
 * (notably manual-AI role screening). `searching` alone is therefore not proof
 * that provider gathering is still touching the recovery snapshot. A card may
 * proceed in that state only after `peek-job-run` observed the *same* run at
 * its durable provider-gathered boundary. Every other state, and a missing/stale peek,
 * remains fail-closed.
 */
export function isJobSourceResolveBusyHubState(hubState, {
  jobRunId = null,
  providerGatheredRunId = null,
} = {}) {
  if (hubState === 'searching' && jobRunId && jobRunId === providerGatheredRunId) {
    return false;
  }
  return [
    'queued',
    'parsing',
    'querying',
    'interpreting-preferences',
    'searching',
    'scoring',
    'evaluating-preferences',
  ].includes(hubState);
}

const DESCRIPTION_RECOVERY_SOURCE_IDS = new Set(['google', 'linkedin', 'glassdoor', 'ziprecruiter']);

export function isDescriptionRecoverySourceWarning(warning) {
  return DESCRIPTION_RECOVERY_SOURCE_IDS.has(warning?.sourceId);
}

/**
 * Is this warning produced by the DESCRIPTION-recovery domain, keyed on the
 * code rather than the source? A Solve re-runs that domain end to end for the
 * source, so any earlier description-phase gate it carried is stale by the time
 * the Solve returns — `description-rate-limited` from the search phase and
 * `description-listing-unavailable` from every Solve pass are the same recovery
 * being reported twice, not two independent blocks. Gates from other domains (a
 * hard block, a LinkedIn rate limit) are a different matter and must survive.
 */
export function isDescriptionRecoveryWarningCode(warning) {
  return typeof warning?.code === 'string' && warning.code.startsWith('description-');
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
