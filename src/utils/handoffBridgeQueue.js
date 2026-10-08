// This module's publication batches are bounded at the IPC edge, but the
// projected list itself is a durable backlog and must never be cut to worker
// capacity.
export const BRIDGE_JOB_PUBLICATION_BATCH_SIZE = 50;

const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ABSOLUTE_PATH_RE = /^(?:\/|[A-Za-z]:[\\/])/;

function isUnsafeLabelCharacter(character) {
  const code = character.codePointAt(0);
  return code <= 31
    || (code >= 127 && code <= 159)
    || (code >= 0x202a && code <= 0x202e)
    || (code >= 0x2066 && code <= 0x2069);
}

export function sanitizeBridgeLabel(value) {
  return [...String(value ?? '')]
    .filter(character => !isUnsafeLabelCharacter(character))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'Application';
}

function dockState(item) {
  if (item?.integrityMessage) return 'broken';
  if (item?.workingState === 'blocked') return 'blocked';
  if (item?.unreadable) return 'unreadable';
  if (item?.working || item?.workingState === 'working') return 'working';
  if (item?.handoffCode && item?.prompt) return 'awaiting';
  return null;
}

function hash(text) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(16).padStart(8, '0');
}

export function projectDockItemsForBridge(items) {
  const found = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.kind !== 'application' || typeof item.jobId !== 'string' || !JOB_ID_RE.test(item.jobId)
        || typeof item.canvasFilePath !== 'string' || item.canvasFilePath.length > 4096
        || !ABSOLUTE_PATH_RE.test(item.canvasFilePath)) continue;
    const state = dockState(item);
    if (!state) continue;
    const corrections = Array.isArray(item.corrections) ? item.corrections.join('\u0000') : '';
    const sig = hash(JSON.stringify([
      item.handoffCode || '',
      item.stage || '',
      item.revision ?? null,
      corrections,
      item.workingState || '',
      item.integrityMessage || '',
    ]));
    const projected = Object.freeze({
      jobId: item.jobId,
      canvasFilePath: item.canvasFilePath,
      dockState: state,
      sig,
    });
    // A corrupt local store must not make a duplicate job's publication depend
    // on discovery order.  The main side sees one canonical value either way.
    const previous = found.get(item.jobId);
    if (!previous || JSON.stringify(projected) < JSON.stringify(previous)) found.set(item.jobId, projected);
  }
  return Object.freeze([...found.values()].sort((a, b) => a.jobId.localeCompare(b.jobId)));
}
export function startBridgeJobPublisher({ api, subscribe, getItems, setTimer = setTimeout, clearTimer = clearTimeout, setIntervalFn = setInterval, clearIntervalFn = clearInterval, debounceMs = 250, keepAliveMs = 30000 } = {}) {
  const bridgeApi = api || globalThis.window?.electronAPI; let stopped = false; let timer = null; let sequence = 0; let publicationSet = 0; let lastKey = null;
  const send = (jobs, force = false, unmount = false) => {
    if (stopped && !unmount) return;
    const key = JSON.stringify(jobs);
    if (!force && key === lastKey) return;
    lastKey = key;
    const publish = bridgeApi?.handoffBridgePublishJobs;
    if (typeof publish !== 'function') return;
    // The IPC schema intentionally bounds one message. Split only transport
    // messages, never the source queue: every chunk is published in stable
    // order and the main process durably accepts/releases it before workers
    // drain it with rolling refill.
    const count = unmount ? 1 : Math.max(1, Math.ceil(jobs.length / BRIDGE_JOB_PUBLICATION_BATCH_SIZE));
    const setId = `jobs-${++publicationSet}`;
    // Do not allocate a second array with one item per IPC page. A queue can be
    // arbitrarily long; only each transport message is bounded. Main applies
    // pages in order and removes stale entries only after the final page.
    for (let index = 0; index < count; index += 1) {
      const chunk = unmount ? [] : jobs.slice(index * BRIDGE_JOB_PUBLICATION_BATCH_SIZE, (index + 1) * BRIDGE_JOB_PUBLICATION_BATCH_SIZE);
      try {
        publish.call(bridgeApi, {
          v: 1,
          seq: ++sequence,
          jobs: chunk,
          ...(!unmount && count > 1 ? { snapshot: { id: setId, index, final: index + 1 === count } } : {}),
          ...(unmount ? { unmount: true } : {}),
        });
      } catch { /* optional IPC surface */ }
    }
  };
  const flush = force => { timer = null; send(projectDockItemsForBridge(typeof getItems === 'function' ? getItems() : []), force); };
  const schedule = () => { if (stopped || timer !== null) return; timer = setTimer(() => flush(false), debounceMs); };
  const unsubscribe = typeof subscribe === 'function' ? subscribe(schedule) : () => {};
  // The first publication can race app startup: the dock has recovered the
  // on-disk job, but main has not yet bound this BrowserWindow to its canvas
  // path and must reject that unbound message. Main emits this payload-free
  // edge after its binding is durable. Clear the de-dup key so an unchanged
  // recovered queue is actually sent again instead of waiting for the normal
  // keep-alive interval.
  let unsubscribeCanvasReady = () => {};
  try {
    const onCanvasReady = bridgeApi?.onHandoffBridgeCanvasFileReady;
    if (typeof onCanvasReady === 'function') {
      const result = onCanvasReady.call(bridgeApi, () => {
        if (stopped) return;
        lastKey = null;
        flush(true);
      });
      if (typeof result === 'function') unsubscribeCanvasReady = result;
    }
  } catch { /* older or incomplete preload surfaces remain optional */ }
  flush(true);
  const keepAlive = setIntervalFn(() => flush(true), keepAliveMs);
  return () => { if (stopped) return; stopped = true; if (timer !== null) clearTimer(timer); try { unsubscribe(); } catch { /* optional subscription cleanup */ } try { unsubscribeCanvasReady(); } catch { /* optional preload listener cleanup */ } clearIntervalFn(keepAlive); send([], true, true); };
}
