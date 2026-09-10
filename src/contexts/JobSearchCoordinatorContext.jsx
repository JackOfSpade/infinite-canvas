import React, { useCallback, useMemo, useState } from 'react';
import { JobSearchCoordinatorContext } from './jobSearchCoordinatorShared';
import { createJobSearchCoordinatorRegistry } from '../utils/jobSearchCoordinatorRegistry';

export function JobSearchCoordinatorProvider({ children }) {
  const [registry] = useState(() => createJobSearchCoordinatorRegistry());

  const registerSearchModule = useCallback(
    (...args) => registry.registerSearchModule(...args),
    [registry],
  );
  const hasSearchModule = useCallback(
    (...args) => registry.hasSearchModule(...args),
    [registry],
  );
  const runSearchModule = useCallback(
    (...args) => registry.runSearchModule(...args),
    [registry],
  );
  const cancelSearchModule = useCallback(
    (...args) => registry.cancelSearchModule(...args),
    [registry],
  );
  const registerBoardModule = useCallback(
    (...args) => registry.registerBoardModule(...args),
    [registry],
  );
  const cancelBoardModule = useCallback(
    (...args) => registry.cancelBoardModule(...args),
    [registry],
  );

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
