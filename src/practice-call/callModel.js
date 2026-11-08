// Pure view-model helpers for the practice-call window. They live in a plain
// .js module so the screen modules only export components (react-refresh).

export const MISSING_PRELOAD = Object.freeze({ phase: 'error', error: { code: 'preload-missing', message: 'The practice call window could not reach its main process. Close it and start the call again from the hub.' } });

export function mergeState(current, patch) {
  if (!patch || typeof patch !== 'object') return current;
  return { ...(current || {}), ...patch };
}

export function mergeEvent(current, event) {
  if (!event || typeof event !== 'object') return current;
  const next = { ...(current || {}) };
  if (event.phase) next.phase = event.phase;
  if (event.kind === 'chat' && event.message) next.chat = [...(Array.isArray(current?.chat) ? current.chat : []), event.message];
  if (event.kind === 'caption' && event.caption) next.captions = [...(Array.isArray(current?.captions) ? current.captions : []), event.caption].slice(-6);
  if (event.kind === 'timing' && event.elapsedMs != null) next.elapsedMs = event.elapsedMs;
  if (event.kind === 'typing') next.typing = !!event.typing;
  return next;
}

// Sizes mirror docs/interview-practice-call-build.md ("models/"): Smart Turn v3
// and the wav2vec2 tone model. Shown before anything is downloaded.
export const MODEL_SIZES = Object.freeze([
  { name: 'Turn-taking model (Smart Turn v3)', size: '32 MB' },
  { name: 'Voice tone model (wav2vec2)', size: '610 MB download' },
]);

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 MB';
  const megabytes = value / (1024 * 1024);
  return `${megabytes >= 100 ? Math.round(megabytes) : megabytes.toFixed(1)} MB`;
}

export function downloadPercent(download) {
  const received = Number(download?.receivedBytes) || 0;
  const total = Number(download?.totalBytes) || 0;
  if (!(total > 0)) return 0;
  return Math.min(100, Math.max(0, Math.round((received / total) * 100)));
}

export const USAGE_WARNING = 'The interviewer is an AI voice. It hears everything you say and the call is analysed afterwards, so use real examples only.';

export const levelPercent = level => {
  const value = Number(level);
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value * 100)));
};

export function humanizeKey(key) {
  return String(key).replace(/Ms$/u, '').replace(/([a-z0-9])([A-Z])/gu, '$1 $2').replace(/[-_]+/gu, ' ').toLowerCase();
}

// The delivery section is written by the post-call review and cites the
// measured metrics; the shape is open, so render whatever fields are present.
export function describeDeliveryValue(value) {
  if (value == null || value === '') return '';
  if (Array.isArray(value)) {
    return value.map(item => (item && typeof item === 'object'
      ? describeDeliveryValue(item.label ?? item.text ?? item.value ?? item)
      : String(item))).filter(Boolean).join('; ');
  }
  if (typeof value === 'object') {
    const cited = value.cited ?? value.metric ?? value.value ?? value.summary;
    if (cited != null && typeof cited !== 'object') return String(cited);
    return Object.entries(value).map(([key, item]) => `${humanizeKey(key)}: ${describeDeliveryValue(item)}`).filter(item => !item.endsWith(': ')).join('; ');
  }
  return String(value);
}
