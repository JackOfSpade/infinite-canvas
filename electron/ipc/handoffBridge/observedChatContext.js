import { createHash } from 'node:crypto';

// Main-side launcher evidence is identity-only outside this module. Renderer
// payloads cannot manufacture a successful browser observation by copying its
// shape; the actual ChatGPT id is neither returned nor retained here.
const observations = new WeakMap();
const workerAvailability = new Set();

// Main-only providers expose a boolean, never conversation ids or content.
// A resolver waits through a short launcher gap instead of letting an
// unobserved worker decide that every other worker is unavailable.
export function registerObservedWorkerAvailability(provider, launchPending = null) {
  if (typeof provider !== 'function') throw new TypeError('An availability provider is required');
  const entry = { available: provider, launchPending };
  workerAvailability.add(entry);
  return () => workerAvailability.delete(entry);
}

export function hasLiveObservedWorker() {
  for (const provider of workerAvailability) {
    try { if (provider.available() === true) return true; } catch { /* a closed engine cannot prove availability */ }
  }
  return false;
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
