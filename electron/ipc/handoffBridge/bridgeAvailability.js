import { resolveHandoffConcurrency } from '../../../src/utils/handoffScheduler.js';
import { CONSTANTS } from './constants.js';
import { getBridgeLauncherAvailability, liveObservedWorkerCount } from './observedChatContext.js';

/** A linked single chat can serve search-time handoffs without a worker pool. */
export const bridgeLinked = status => status?.enabled === true && status?.link?.state === 'linked';

/** A pool is one supported transport; a linked single chat can also serve handoffs. */
export const bridgeWorkerPoolActive = status => bridgeLinked(status) && status?.chat?.pool?.active === true;

/** Main-owned evidence distinguishes live chats and actual launches from
 * minted starters and demand-derived pool recommendations. Busy chats count. */
export function bridgeHandoffAvailability(status) {
  const launcher = getBridgeLauncherAvailability();
  const serving = bridgeLinked(status) && (status?.serving === undefined || status.serving === 'live');
  const singleChatLive = ['reached', 'working'].includes(status?.chat?.state);
  // A manually connected worker is transport-live too. Admission and waiting
  // do not grant comparison authority; push.js still enforces observed A/B
  // context isolation, and parallel comparisons require observed counts.
  const connected = (status?.chat?.pool?.workers || []).filter(worker => worker.firstCallAt != null
    && ['working', 'waiting', 'quiet'].includes(worker.state)
    && worker.quietReason !== 'fresh_context_required'
    && !['session_full', 'session_ended'].includes(worker.lastOutcome)).length;
  return {
    liveWorkers: !serving ? 0 : bridgeWorkerPoolActive(status)
      ? Math.max(liveObservedWorkerCount(), connected) : Number(singleChatLive),
    launchesInProgress: launcher.inProgress,
    launchPending: launcher.pending,
    autoLaunchAvailable: bridgeLinked(status) && launcher.available,
  };
}

/** One extra admitted request creates expansion demand. As each chat comes
 * up, the resolver can admit another request without flooding a slow launcher.
 * A linked chat without a pool always retains serial admission. */
export function bridgeHandoffCapacity(status, evidence = bridgeHandoffAvailability(status)) {
  if (!bridgeWorkerPoolActive(status)) return 1;
  const count = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
  const demand = count(evidence.liveWorkers) + count(evidence.launchesInProgress) + 1;
  return Math.min(CONSTANTS.MAX_LANES, resolveHandoffConcurrency(status?.limits), demand);
}

/** Observed-worker absence applies only to pool transport. A linked single
 * chat has no worker roster and must remain eligible through its own timeout. */
export function bridgeComparisonAvailable(status, observedWorkerAvailable) {
  if (!bridgeLinked(status)) return false;
  if (status?.serving !== undefined && status.serving !== 'live') return false;
  if (!bridgeWorkerPoolActive(status)) return true;
  try { return observedWorkerAvailable?.() === true; } catch { return false; }
}
