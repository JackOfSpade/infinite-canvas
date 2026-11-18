import React, { useMemo, useState } from 'react';
import { JobSearchCoordinatorContext } from './jobSearchCoordinatorShared';
import { createJobSearchCoordinatorRegistry } from '../utils/jobSearchCoordinatorRegistry';

export function JobSearchCoordinatorProvider({ children }) {
  const [registry] = useState(() => createJobSearchCoordinatorRegistry());

  const value = useMemo(() => ({
    registerSearchModule: (...args) => registry.registerSearchModule(...args),
    runSearchModule: (...args) => registry.runSearchModule(...args),
    cancelSearchModule: (...args) => registry.cancelSearchModule(...args),
    hasSearchModule: (...args) => registry.hasSearchModule(...args),
    registerBoardModule: (...args) => registry.registerBoardModule(...args),
    cancelBoardModule: (...args) => registry.cancelBoardModule(...args),
    pauseSearchModule: (...args) => registry.pauseSearchModule(...args),
    pauseBoardModule: (...args) => registry.pauseBoardModule(...args),
  }), [registry]);

  return (
    <JobSearchCoordinatorContext.Provider value={value}>
      {children}
    </JobSearchCoordinatorContext.Provider>
  );
}
