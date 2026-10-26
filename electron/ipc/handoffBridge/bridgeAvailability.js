/** A linked single chat can serve search-time handoffs without a worker pool. */
export const bridgeLinked = status => status?.enabled === true && status?.link?.state === 'linked';

/** Generation keeps its existing requirement for an active worker pool. */
export const bridgeWorkerPoolActive = status => bridgeLinked(status) && status?.chat?.pool?.active === true;
