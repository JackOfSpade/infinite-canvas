/** A linked single chat can serve search-time handoffs without a worker pool. */
export const bridgeLinked = status => status?.enabled === true && status?.link?.state === 'linked';

/** A pool is one supported transport; a linked single chat can also serve handoffs. */
export const bridgeWorkerPoolActive = status => bridgeLinked(status) && status?.chat?.pool?.active === true;

/** Observed-worker absence applies only to pool transport. A linked single
 * chat has no worker roster and must remain eligible through its own timeout. */
export function bridgeComparisonAvailable(status, observedWorkerAvailable) {
  if (!bridgeLinked(status)) return false;
  if (!bridgeWorkerPoolActive(status)) return true;
  try { return observedWorkerAvailable?.() === true; } catch { return false; }
}
