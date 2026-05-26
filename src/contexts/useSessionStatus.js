import { useContext } from 'react';
import { SessionStatusContext } from './sessionStatusShared';

export function usePlatformsVerifying(platformIds) {
  const { verifying } = useContext(SessionStatusContext);
  return platformIds.some(id => verifying.has(id));
}

export function usePlatformsVerifyingProgress(platformIds) {
  const { verifying } = useContext(SessionStatusContext);
  const total = platformIds.length;
  const done = platformIds.filter(id => !verifying.has(id)).length;
  return { verifying: platformIds.some(id => verifying.has(id)), done, total };
}
