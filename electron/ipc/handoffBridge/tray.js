import electronPkg from 'electron';

// Tiny, self-contained PNGs keep the menu-bar indicator available before the
// renderer/assets have loaded. They intentionally differ by glyph state; the
// production Tray receives the matching image on every state transition.
export const TRAY_ICON_DATA_URIS = Object.freeze({
  idle: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNIKen+DwAFBgJjLYq+4AAAAABJRU5ErkJggg==',
  live: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQOhr3HwAElwJF/XRl9gAAAABJRU5ErkJggg==',
  active: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOwbvr2HwAFYgKzn+LXXwAAAABJRU5ErkJggg==',
  paused: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4Oo/7PwAGyAKePH9QXgAAAABJRU5ErkJggg==',
  alarm: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGN47+LyHwAGFAJ3AHU+LgAAAABJRU5ErkJggg==',
});
// Keep the Tray's anomaly sheet on the same closed, main-owned facts as IPC.
// A status alarm's opaque id and any unknown fields never reach a dialog.
const ANOMALY_ALARM_FACTS = Object.freeze({
  unknown_key: Object.freeze({ count: 5, minutes: 10 }),
  unknown_handoff: Object.freeze({ count: 5, minutes: 10 }),
  misrouted: Object.freeze({ count: 5, minutes: 10 }),
  rate_limited: Object.freeze({ count: 50, minutes: 1 }),
  held_caps: Object.freeze({ count: 3, minutes: 60 }),
});

function anomalyResumeDetails(status) {
  if (!Array.isArray(status?.alarms)) return null;
  const alarm = status.alarms.find(item => item?.acknowledged !== true && Object.hasOwn(ANOMALY_ALARM_FACTS, item?.kind));
  if (!alarm) return null;
  const facts = ANOMALY_ALARM_FACTS[alarm.kind];
  const at = Number(alarm.at);
  return {
    reason: 'anomaly',
    count: facts.count,
    minutes: facts.minutes,
    at: Number.isSafeInteger(at) && at >= 0 ? at : null,
  };
}

export function snapshotToTray(status = {}) {
  if (!status?.enabled) return { visible: false, glyph: 'off', badge: '' };
  if (Array.isArray(status.alarms) && status.alarms.some(alarm => !alarm?.acknowledged)) return { visible: true, glyph: 'alarm', badge: '!' };
  if (status.serving === 'paused') return { visible: true, glyph: 'paused', badge: '⏸' };
  // `up` is the public controller state. Never let a raw supervisor state
  // (including `online`) imply that the bridge is live in the tray.
  if (status.tunnel?.state !== 'up') return { visible: true, glyph: 'idle', badge: '' };
  return { visible: true, glyph: status.chat?.state === 'working' ? 'active' : 'live', badge: '' };
}

export function createHandoffBridgeTray({
  Tray = electronPkg.Tray,
  Menu = electronPkg.Menu,
  nativeImage = electronPkg.nativeImage,
  app = electronPkg.app,
  getCanvasWindows = () => [],
  controller = {},
  dialogs = {},
  onOpenPanel = () => undefined,
  notify = () => undefined,
} = {}) {
  let tray = null;
  let last = null;
  let glyph = null;
  let expiryNudged = false;
  const canvasWindows = () => {
    try { return (getCanvasWindows() || []).filter(window => !window?.isDestroyed?.()); } catch { return []; }
  };
  const canvas = () => canvasWindows()[0] || null;
  const icon = nextGlyph => {
    const dataUri = TRAY_ICON_DATA_URIS[nextGlyph] || TRAY_ICON_DATA_URIS.idle;
    try { return nativeImage?.createFromDataURL?.(dataUri); } catch { return null; }
  };
  const setDockBadge = badge => { try { app?.dock?.setBadge?.(badge); } catch { /* Dock is optional */ } };
  const openPanel = value => {
    const step = value?.step;
    const parent = canvas();
    try { parent?.show?.(); parent?.focus?.(); } catch { /* the panel callback remains useful */ }
    try { onOpenPanel({ panel: 'bridge', ...(Number.isInteger(step) ? { step } : {}) }); } catch { /* renderer delivery is optional */ }
  };
  // A tray click is main-process initiated, but an outstanding handoff still
  // deserves the same interruption acknowledgement as the renderer controls.
  // Read the controller's current projection where available instead of
  // relying only on the last paint, and never move a pending sheet to another
  // canvas if its original parent disappears.
  const currentStatus = () => {
    try { return controller.snapshot?.(false) || last; } catch { return last; }
  };
  const stillOwnsCanvas = window => {
    try { return Boolean(window && !window.isDestroyed?.() && canvasWindows().some(candidate => candidate === window)); } catch { return false; }
  };
  async function resume() {
    const parent = canvas();
    if (last?.pauseCause === 'anomaly') {
      if (!parent) return;
      try { parent.show?.(); parent.focus?.(); } catch { /* the sheet must be parented */ }
      const details = anomalyResumeDetails(last);
      if (!details) return;
      const answer = await dialogs.ask?.(parent.webContents, 'resume', details);
      if (!answer?.ok || !stillOwnsCanvas(parent)) return;
    }
    await controller.resume?.();
  }
  async function disable() {
    const status = currentStatus();
    if (status?.chat?.outstanding) {
      const parent = canvas();
      if (!parent) return;
      const answer = await dialogs.ask?.(parent.webContents, 'disable');
      if (!answer?.ok || !stillOwnsCanvas(parent)) return;
    }
    await controller.disable?.();
  }
  function ensure(nextGlyph) {
    if (tray || typeof Tray !== 'function') return tray;
    try { tray = new Tray(icon(nextGlyph)); glyph = nextGlyph; tray.on?.('click', openPanel); } catch { tray = null; glyph = null; }
    return tray;
  }
  const nudgeForExpiry = status => {
    if (status?.enabled !== true || status?.link?.expiresSoon !== true) {
      expiryNudged = false;
      return;
    }
    if (expiryNudged) return;
    expiryNudged = true;
    try { notify('link-expiring'); } catch { /* generic notification is optional */ }
  };
  function apply(status = {}) {
    last = status;
    const view = snapshotToTray(status);
    nudgeForExpiry(status);
    if (!view.visible) { try { tray?.destroy?.(); } catch { /* optional */ } tray = null; glyph = null; setDockBadge(''); return view; }
    const item = ensure(view.glyph);
    if (!item) return view;
    if (glyph !== view.glyph) {
      try { item.setImage?.(icon(view.glyph)); } catch { /* visual updates are optional */ }
      glyph = view.glyph;
    }
    const window = canvas();
    const anomalyResumeReady = status.pauseCause !== 'anomaly' || Boolean(window && anomalyResumeDetails(status));
    const menu = [
      { label: 'Open Handoff bridge', click: openPanel },
      {
        label: status.serving === 'paused' ? 'Resume' : 'Pause',
        enabled: status.serving !== 'paused' || anomalyResumeReady,
        click: () => (status.serving === 'paused' ? resume() : controller.pause?.()),
      },
    ];
    // Connecting is recovery guidance, not a permanent menu affordance. The
    // public controller projection owns this closed link state; do not infer
    // it from timestamps or any OAuth diagnostic.
    if (status?.link?.state === 'unlinked') menu.splice(1, 0, { label: 'Connect ChatGPT', click: () => openPanel({ step: 3 }) });
    if (status.link?.expiresSoon) menu.push({ label: 'ChatGPT link expires soon', enabled: false });
    menu.push({ label: 'Revoke all', click: () => controller.revokeAll?.() });
    menu.push({ label: 'Turn off', click: disable });
    try { item.setContextMenu?.(Menu?.buildFromTemplate?.(menu)); item.setToolTip?.('Infinite Canvas Handoff bridge'); } catch { /* optional */ }
    setDockBadge(view.badge);
    return view;
  }
  function alarm(status = last) {
    // Badge/glyph are independent of notification permission.
    if (status) apply(status);
    try { notify('paused'); } catch { /* notification is optional */ }
  }
  function destroy() { try { tray?.destroy?.(); } catch { /* optional */ } tray = null; glyph = null; expiryNudged = false; setDockBadge(''); }
  return Object.freeze({ apply, alarm, destroy, snapshotToTray });
}

export default createHandoffBridgeTray;
