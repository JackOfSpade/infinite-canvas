import { useContext } from 'react';
import { SessionStatusContext } from './sessionStatusShared';

export function usePlatformsVerifyingProgress(platformIds) {
  const { verifying } = useContext(SessionStatusContext);
  const total = platformIds.length;
  const done = platformIds.filter(id => !verifying.has(id)).length;
  return { verifying: platformIds.some(id => verifying.has(id)), done, total };
}
