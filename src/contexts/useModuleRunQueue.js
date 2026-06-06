import { useContext } from 'react';
import { ModuleRunQueueContext } from './moduleRunQueueShared';

export function useModuleRunQueue() {
  const queue = useContext(ModuleRunQueueContext);
  if (!queue) {
    throw new Error('useModuleRunQueue must be used within a ModuleRunQueueProvider');
  }
  return queue;
}
