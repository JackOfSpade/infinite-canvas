function unavailable(kind, nodeId) {
  const label = kind === 'board' ? 'Job Board Module' : 'Job Search Module';
  const error = new Error(`${label} ${nodeId || '(unknown)'} is not available`);
  error.code = kind === 'board'
    ? 'JOB_BOARD_MODULE_UNAVAILABLE'
    : 'JOB_SEARCH_MODULE_UNAVAILABLE';
  error.nodeId = nodeId || null;
  return error;
}

function deferIdentityRemoval(registrations, nodeId, registration) {
  Promise.resolve().then(() => Promise.resolve().then(() => {
    if (registrations.get(nodeId) === registration) registrations.delete(nodeId);
  }));
}

/**
 * Stateful, renderer-independent registry for Board/Search coordination.
 * Search unmount closes new work immediately but keeps its exact canceller for
 * the cleanup turn. Boards expose cancellation only, so a closing Board must
 * likewise remain cancellable until its identity-checked deferred removal.
 */
export function createJobSearchCoordinatorRegistry() {
  const searchRegistrations = new Map();
  const boardRegistrations = new Map();

  const registerSearchModule = (nodeId, runner, canceller = null) => {
    if (typeof nodeId !== 'string' || !nodeId.trim()) {
      throw new Error('registerSearchModule requires a node id');
    }
    if (typeof runner !== 'function') {
      throw new Error(`registerSearchModule requires a runner for ${nodeId}`);
    }
    if (canceller != null && typeof canceller !== 'function') {
      throw new Error(`registerSearchModule requires a cancellation handler for ${nodeId}`);
    }
    const registration = { runner, canceller, closing: false };
    searchRegistrations.set(nodeId, registration);
    return () => {
      registration.closing = true;
      deferIdentityRemoval(searchRegistrations, nodeId, registration);
    };
  };

  const hasSearchModule = (nodeId) => {
    const registration = searchRegistrations.get(nodeId);
    return !!registration && !registration.closing;
  };

  const runSearchModule = (nodeId, options = {}) => {
    const registration = searchRegistrations.get(nodeId);
    if (!registration || registration.closing) return Promise.reject(unavailable('search', nodeId));
    return Promise.resolve().then(() => {
      if (registration.closing || searchRegistrations.get(nodeId) !== registration) {
        throw unavailable('search', nodeId);
      }
      return registration.runner(options);
    });
  };

  const cancelSearchModule = (nodeId, options = {}) => {
    const registration = searchRegistrations.get(nodeId);
    if (!registration) return Promise.reject(unavailable('search', nodeId));
    if (typeof registration.canceller !== 'function') {
      const error = new Error(`Job Search Module ${nodeId} does not expose cancellation`);
      error.code = 'JOB_SEARCH_MODULE_NOT_CANCELLABLE';
      error.nodeId = nodeId;
      return Promise.reject(error);
    }
    try {
      return Promise.resolve(registration.canceller(options));
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const registerBoardModule = (nodeId, canceller) => {
    if (typeof nodeId !== 'string' || !nodeId.trim() || typeof canceller !== 'function') {
      throw new Error('registerBoardModule requires a node id and cancellation handler');
    }
    const registration = { canceller, closing: false };
    boardRegistrations.set(nodeId, registration);
    return () => {
      // A Board has no runner to fence. Keep its exact canceller available
      // during unmount so a deletion/navigation cleanup can still settle its
      // current transaction; a replacement wins through the identity check.
      registration.closing = true;
      deferIdentityRemoval(boardRegistrations, nodeId, registration);
    };
  };

  const cancelBoardModule = (nodeId, options = {}) => {
    const registration = boardRegistrations.get(nodeId);
    if (!registration) return Promise.reject(unavailable('board', nodeId));
    try {
      return Promise.resolve(registration.canceller(options));
    } catch (error) {
      return Promise.reject(error);
    }
  };

  return {
    registerSearchModule,
    hasSearchModule,
    runSearchModule,
    cancelSearchModule,
    registerBoardModule,
    cancelBoardModule,
  };
}
