import React, { useCallback, useMemo, useRef } from 'react';
import { JobSearchCoordinatorContext } from './jobSearchCoordinatorShared';

export function JobSearchCoordinatorProvider({ children }) {
  const registrationsRef = useRef(new Map());
  const boardRegistrationsRef = useRef(new Map());

  const registerSearchModule = useCallback((nodeId, runner, canceller = null) => {
    if (typeof nodeId !== 'string' || !nodeId.trim()) {
      throw new Error('registerSearchModule requires a node id');
    }
    if (typeof runner !== 'function') {
      throw new Error(`registerSearchModule requires a runner for ${nodeId}`);
    }
    if (canceller != null && typeof canceller !== 'function') {
      throw new Error(`registerSearchModule requires a cancellation handler for ${nodeId}`);
    }

    const registration = { runner, canceller };
    registrationsRef.current.set(nodeId, registration);

    // Only the registration that installed this runner may remove it. This
    // protects a fresh callback from a stale effect cleanup for the same node.
    return () => {
      // Board/Search components unmount in the same React commit when canvas
      // navigation swaps levels. Board cleanup is deliberately microtask-
      // deferred to ignore StrictMode's mount replay, so keep this exact
      // canceller alive through that cleanup turn. A replacement registration
      // wins via the identity check and is never removed by the old callback.
      Promise.resolve().then(() => Promise.resolve().then(() => {
        if (registrationsRef.current.get(nodeId) === registration) {
          registrationsRef.current.delete(nodeId);
        }
      }));
    };
  }, []);

  const hasSearchModule = useCallback(
    (nodeId) => registrationsRef.current.has(nodeId),
    [],
  );

  const runSearchModule = useCallback((nodeId, options = {}) => {
    const registration = registrationsRef.current.get(nodeId);
    if (!registration) {
      const error = new Error(`Job Search Module ${nodeId || '(unknown)'} is not available`);
      error.code = 'JOB_SEARCH_MODULE_UNAVAILABLE';
      error.nodeId = nodeId || null;
      return Promise.reject(error);
    }

    // Normalize synchronous throws and accidental non-Promise runners into the
    // same Promise contract consumed by the Job Board coordinator.
    return Promise.resolve().then(() => registration.runner(options));
  }, []);

  const cancelSearchModule = useCallback((nodeId, options = {}) => {
    const registration = registrationsRef.current.get(nodeId);
    if (!registration) {
      const error = new Error(`Job Search Module ${nodeId || '(unknown)'} is not available`);
      error.code = 'JOB_SEARCH_MODULE_UNAVAILABLE';
      error.nodeId = nodeId || null;
      return Promise.reject(error);
    }
    if (typeof registration.canceller !== 'function') {
      const error = new Error(`Job Search Module ${nodeId} does not expose cancellation`);
      error.code = 'JOB_SEARCH_MODULE_NOT_CANCELLABLE';
      error.nodeId = nodeId;
      return Promise.reject(error);
    }

    // Start cancellation synchronously. The Board's next statement may clear
    // its durable recovery plan, which is part of the exact authority a
    // post-reload child canceller verifies. Promise normalization is retained
    // without deferring that authorization check to a later microtask.
    try {
      return Promise.resolve(registration.canceller(options));
    } catch (error) {
      return Promise.reject(error);
    }
  }, []);

  const registerBoardModule = useCallback((nodeId, canceller) => {
    if (typeof nodeId !== 'string' || !nodeId.trim() || typeof canceller !== 'function') {
      throw new Error('registerBoardModule requires a node id and cancellation handler');
    }
    const registration = { canceller };
    boardRegistrationsRef.current.set(nodeId, registration);
    return () => {
      Promise.resolve().then(() => Promise.resolve().then(() => {
        if (boardRegistrationsRef.current.get(nodeId) === registration) {
          boardRegistrationsRef.current.delete(nodeId);
        }
      }));
    };
  }, []);

  const cancelBoardModule = useCallback((nodeId, options = {}) => {
    const registration = boardRegistrationsRef.current.get(nodeId);
    if (!registration) {
      const error = new Error(`Job Board Module ${nodeId || '(unknown)'} is not available`);
      error.code = 'JOB_BOARD_MODULE_UNAVAILABLE';
      error.nodeId = nodeId || null;
      return Promise.reject(error);
    }
    try {
      return Promise.resolve(registration.canceller(options));
    } catch (error) {
      return Promise.reject(error);
    }
  }, []);

  const value = useMemo(() => ({
    registerSearchModule,
    runSearchModule,
    cancelSearchModule,
    hasSearchModule,
    registerBoardModule,
    cancelBoardModule,
  }), [cancelBoardModule, cancelSearchModule, hasSearchModule, registerBoardModule, registerSearchModule, runSearchModule]);

  return (
    <JobSearchCoordinatorContext.Provider value={value}>
      {children}
    </JobSearchCoordinatorContext.Provider>
  );
}
