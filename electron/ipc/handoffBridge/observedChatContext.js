import { createHash } from 'node:crypto';

// Main-side launcher evidence is identity-only outside this module. Renderer
// payloads cannot manufacture a successful browser observation by copying its
// shape; the actual ChatGPT id is neither returned nor retained here.
const observations = new WeakMap();
const workerAvailability = new Set();
const launcherAvailability = new Set();

// Main-only providers expose availability/counts, never conversation ids or content.
// A resolver waits through a short launcher gap instead of letting an
// unobserved worker decide that every other worker is unavailable.
export function registerObservedWorkerAvailability(provider, launchPending = null, liveCount = null) {
  if (typeof provider !== 'function') throw new TypeError('An availability provider is required');
  const entry = { available: provider, launchPending, liveCount };
  workerAvailability.add(entry);
  return () => workerAvailability.delete(entry);
}

export function hasLiveObservedWorker(minimum = 1) {
  if (!Number.isSafeInteger(minimum) || minimum < 1) return false;
  for (const provider of workerAvailability) {
    try {
      if (provider.available() !== true) continue;
      if (minimum === 1) return true;
      const count = provider.liveCount?.();
      if (Number.isSafeInteger(count) && count >= minimum) return true;
    } catch { /* a closed engine cannot prove availability */ }
  }
  return false;
}

export function liveObservedWorkerCount() {
  let total = 0;
  for (const provider of workerAvailability) {
    try {
      if (provider.available() !== true) continue;
      const count = provider.liveCount?.();
      total = Math.min(Number.MAX_SAFE_INTEGER, total + (Number.isSafeInteger(count) && count > 0 ? count : 1));
    } catch { /* a closed engine cannot prove availability */ }
  }
  return total;
}

// The launcher owns queued starts and delayed retries, which are not visible
// in the engine's roster of minted starters. Keep this evidence main-only.
export function registerBridgeLauncherAvailability(provider) {
  if (typeof provider !== 'function') throw new TypeError('A launcher availability provider is required');
  launcherAvailability.add(provider);
  return () => launcherAvailability.delete(provider);
}

export function getBridgeLauncherAvailability() {
  let available = false; let pending = false; let inProgress = 0;
  for (const provider of launcherAvailability) {
    try {
      const current = provider();
      available ||= current?.available === true;
      pending ||= current?.pending === true;
      if (Number.isSafeInteger(current?.inProgress) && current.inProgress > 0) {
        inProgress = Math.min(Number.MAX_SAFE_INTEGER, inProgress + current.inProgress);
      }
    } catch { /* a detached launcher cannot prove availability */ }
  }
  return { available, pending, inProgress };
}

export function hasPendingObservedWorkerLaunch() {
  for (const provider of workerAvailability) {
    try { if (provider.launchPending?.() === true) return true; } catch { /* no current launch proof */ }
  }
  return false;
}

export function createObservedChatContext(chatId, kind = 'new') {
  if (typeof chatId !== 'string' || !/^[a-z0-9-]{1,128}$/iu.test(chatId) || !['new', 'continue'].includes(kind)) return null;
  const token = Object.freeze({});
  observations.set(token, Object.freeze({
    conversationKey: createHash('sha256').update(`observed-chatgpt:${chatId}`).digest('hex'),
    fresh: kind === 'new',
  }));
  return token;
}

export function observedChatContext(value) {
  return value && typeof value === 'object' ? observations.get(value) || null : null;
}
