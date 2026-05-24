import React, { createContext, useContext, useEffect, useState } from 'react';

const Ctx = createContext({ statuses: {}, verifying: new Set() });

export function SessionStatusProvider({ children }) {
  const [statuses, setStatuses] = useState({});
  const [verifying, setVerifying] = useState(new Set());

  useEffect(() => {
    // Sync with whatever state the startup verify has already reached before
    // this component mounted (handles the race where verify starts before React loads).
    window.electronAPI.getVerifyState?.().then(({ verifying: vIds = [], statuses: s = {} }) => {
      setStatuses(s);
      setVerifying(new Set(vIds));
    });

    const unsubStart = window.electronAPI.onSessionVerifyStart?.(({ platformIds }) => {
      setVerifying(new Set(platformIds));
    });
    const unsubUpdate = window.electronAPI.onSessionVerifyUpdate?.(({ platformId, connected }) => {
      setStatuses(prev => ({ ...prev, [platformId]: { connected } }));
      setVerifying(prev => {
        const next = new Set(prev);
        next.delete(platformId);
        return next;
      });
    });
    const unsubDone = window.electronAPI.onSessionVerifyDone?.(() => {
      setVerifying(new Set());
    });

    return () => { unsubStart?.(); unsubUpdate?.(); unsubDone?.(); };
  }, []);

  return (
    <Ctx.Provider value={{ statuses, verifying }}>
      {children}
    </Ctx.Provider>
  );
}

export function usePlatformsVerifying(platformIds) {
  const { verifying } = useContext(Ctx);
  return platformIds.some(id => verifying.has(id));
}

export function usePlatformsVerifyingProgress(platformIds) {
  const { verifying } = useContext(Ctx);
  const total = platformIds.length;
  const done = platformIds.filter(id => !verifying.has(id)).length;
  return { verifying: platformIds.some(id => verifying.has(id)), done, total };
}
