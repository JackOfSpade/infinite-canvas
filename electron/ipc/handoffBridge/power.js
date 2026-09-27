import electronPkg from 'electron';
import { CONSTANTS } from './constants.js';

/**
 * Keep-awake is intentionally inert until the measured switch is enabled.
 * A recent chat can keep the process awake, but only a window that owns a
 * host-phase lane is allowed to have renderer background throttling relaxed.
 */
export function createHandoffBridgePower({
  powerSaveBlocker = electronPkg.powerSaveBlocker,
  powerMonitor = electronPkg.powerMonitor,
  getCanvasWindows = () => [],
  enabled = CONSTANTS.KEEP_AWAKE_ENABLED,
  onSuspend = () => undefined,
  onResume = () => undefined,
  now = Date.now,
  timers = globalThis,
} = {}) {
  let blockerId = null;
  let active = false;
  let unthrottledWindowIds = new Set();
  let suspendListening = false;
  let resumeListening = false;
  let suspendedAt = null;
  let recentTimer = null;
  let recentDeadline = null;
  let latest = { hostLane: false, awaitingLane: false, hostWindowIds: [], lastCallAt: null, recentChat: false };

  const liveWindows = () => {
    try { return (getCanvasWindows() || []).filter(window => !window?.isDestroyed?.()); } catch { return []; }
  };
  const windowId = window => window?.webContents?.id;
  const setWindowThrottle = (ids, value) => {
    for (const window of liveWindows()) {
      if (!ids.has(windowId(window))) continue;
      try { window.webContents?.setBackgroundThrottling?.(value); } catch { /* best effort cleanup */ }
    }
  };
  const hostIds = value => new Set(Array.isArray(value)
    ? value.filter(id => Number.isInteger(id) || typeof id === 'string')
    : []);
  const stamp = () => {
    try { const value = Number(now?.()); return Number.isFinite(value) ? value : Date.now(); }
    catch { return Date.now(); }
  };
  const clearRecentTimer = () => {
    if (recentTimer === null) return;
    try { timers?.clearTimeout?.(recentTimer); } catch { /* best effort cleanup */ }
    recentTimer = null;
  };
  const validLastCallAt = value => Number.isFinite(value) && value >= 0;
  const recentFrom = (lastCallAt, explicitRecent) => {
    if (!validLastCallAt(lastCallAt)) return explicitRecent === true;
    return stamp() < lastCallAt + CONSTANTS.KEEP_AWAKE_MINUTES * 60_000;
  };
  const scheduleRecentExpiry = lastCallAt => {
    clearRecentTimer();
    recentDeadline = null;
    if (!validLastCallAt(lastCallAt)) return;
    const deadline = lastCallAt + CONSTANTS.KEEP_AWAKE_MINUTES * 60_000;
    const delay = deadline - stamp();
    if (!(delay > 0) || typeof timers?.setTimeout !== 'function') return;
    recentDeadline = deadline;
    try {
      recentTimer = timers.setTimeout(() => {
        recentTimer = null;
        if (recentDeadline !== deadline) return;
        // Re-evaluate the retained private facts at the exact deadline. This
        // releases a call-only blocker without waiting for a status mutation.
        update(latest);
      }, delay);
      recentTimer?.unref?.();
    } catch { recentTimer = null; recentDeadline = null; }
  };

  const suspended = () => {
    // Suspend has no externally visible effect.  Its timestamp is retained
    // only so the platform seam remains observable without widening status.
    try {
      const stamp = now?.();
      suspendedAt = Number.isFinite(stamp) ? stamp : Date.now();
    } catch { suspendedAt = Date.now(); }
    try { onSuspend(); } catch { /* no status data crosses this boundary */ }
  };
  const resumed = () => {
    if (suspendedAt !== null) suspendedAt = null;
    try { onResume(); } catch { /* no status data crosses this boundary */ }
  };
  // Lifecycle recovery is independent from the measured keep-awake switch.
  // The false default remains a hard no-op for Electron power-saving ports,
  // but suspend/resume must still wake stale bridge work.
  try { powerMonitor?.on?.('suspend', suspended); suspendListening = typeof powerMonitor?.on === 'function'; } catch { /* optional platform hook */ }
  try { powerMonitor?.on?.('resume', resumed); resumeListening = typeof powerMonitor?.on === 'function'; } catch { /* optional platform hook */ }

  function update({ hostLane = false, awaitingLane = false, lastCallAt = null, recentChat = false, hostWindowIds = [] } = {}) {
    // The false default is a hard no-op: even stop() must not touch Electron
    // ports, which makes B9's measurement switch observable and reversible.
    if (!enabled) return false;
    latest = {
      hostLane: hostLane === true,
      awaitingLane: awaitingLane === true,
      hostWindowIds: Array.isArray(hostWindowIds) ? [...hostWindowIds] : [],
      lastCallAt: validLastCallAt(lastCallAt) ? lastCallAt : null,
      // Retained only for direct deterministic seam tests. Composition supplies
      // lastCallAt, whose bounded deadline is the production authority.
      recentChat: recentChat === true,
    };
    const nextHostWindows = latest.hostLane ? hostIds(latest.hostWindowIds) : new Set();
    const stale = new Set([...unthrottledWindowIds].filter(id => !nextHostWindows.has(id)));
    const added = new Set([...nextHostWindows].filter(id => !unthrottledWindowIds.has(id)));
    if (stale.size) setWindowThrottle(stale, true);
    if (added.size) setWindowThrottle(added, false);
    unthrottledWindowIds = nextHostWindows;

    const recent = recentFrom(latest.lastCallAt, latest.recentChat);
    scheduleRecentExpiry(latest.lastCallAt);
    const next = Boolean(latest.hostLane || latest.awaitingLane || recent);
    if (next === active) return active;
    active = next;
    if (next) {
      try { blockerId = powerSaveBlocker?.start?.('prevent-app-suspension') ?? null; } catch { blockerId = null; }
    } else if (blockerId !== null) {
      try { powerSaveBlocker?.stop?.(blockerId); } catch { /* cleanup continues */ }
      blockerId = null;
    }
    return active;
  }
  function stop() {
    clearRecentTimer(); recentDeadline = null;
    return update({ hostLane: false, awaitingLane: false, lastCallAt: null, recentChat: false, hostWindowIds: [] });
  }
  function dispose() {
    stop();
    if (suspendListening) try { powerMonitor?.removeListener?.('suspend', suspended); } catch { /* optional Electron port */ }
    if (resumeListening) try { powerMonitor?.removeListener?.('resume', resumed); } catch { /* optional Electron port */ }
    suspendListening = false;
    resumeListening = false;
    suspendedAt = null;
  }
  return Object.freeze({ update, stop, dispose, isEnabled: () => enabled, isActive: () => active });
}

export default createHandoffBridgePower;
