import React, { useEffect, useState } from 'react';
import { SessionStatusContext } from './sessionStatusShared';

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
    <SessionStatusContext.Provider value={{ statuses, verifying }}>
      {children}
    </SessionStatusContext.Provider>
  );
}
