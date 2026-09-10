import { useContext } from 'react';
import { JobSearchCoordinatorContext } from './jobSearchCoordinatorShared';

export function useJobSearchCoordinator() {
  const coordinator = useContext(JobSearchCoordinatorContext);
  if (!coordinator) {
    throw new Error('useJobSearchCoordinator must be used within a JobSearchCoordinatorProvider');
  }
  return coordinator;
}
