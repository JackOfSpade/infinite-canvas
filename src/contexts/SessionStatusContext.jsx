import React, { useEffect, useRef, useState } from 'react';
import { SessionStatusContext } from './sessionStatusShared';

export function SessionStatusProvider({ children }) {
  const [verifying, setVerifying] = useState(new Set());
  // A verify start/update/done event can land between mount and the async
  // getVerifyState reply (the renderer normally mounts mid-verify). Once any
  // live event has applied, the late-resolving startup snapshot must NOT
  // overwrite it — otherwise a platform an update already cleared would be
  // re-added and the Job Search Module/SellHub progress bar would regress to "checking"
  // until verify-done. This ref makes the snapshot a baseline, not an override.
  const gotLiveEvent = useRef(false);

  useEffect(() => {
    const api = globalThis.window?.electronAPI;
    if (!api) return undefined;

    // Seed from whatever state the startup verify reached before React mounted,
    // but only if no live event has been applied yet (handles the verify-starts-
    // before-React race without clobbering newer in-flight events).
    api.getVerifyState?.()?.then(({ verifying: vIds = [] }) => {
      if (gotLiveEvent.current) return;
      setVerifying(new Set(vIds));
    }).catch(() => {});

    const unsubStart = api.onSessionVerifyStart?.(({ platformIds }) => {
      gotLiveEvent.current = true;
      setVerifying(new Set(platformIds));
    });
    const unsubUpdate = api.onSessionVerifyUpdate?.(({ platformId }) => {
      gotLiveEvent.current = true;
      setVerifying(prev => {
        const next = new Set(prev);
        next.delete(platformId);
        return next;
      });
    });
    const unsubDone = api.onSessionVerifyDone?.(() => {
      gotLiveEvent.current = true;
      setVerifying(new Set());
    });

    return () => { unsubStart?.(); unsubUpdate?.(); unsubDone?.(); };
  }, []);

  return (
    <SessionStatusContext.Provider value={{ verifying }}>
      {children}
    </SessionStatusContext.Provider>
  );
}
