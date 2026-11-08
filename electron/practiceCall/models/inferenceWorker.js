// Host side of the practice-call inference worker. The worker entry lives in
// inferenceWorkerThread.js so the app bundle can build it as its own entry:
// this module never starts itself, it only spawns that file by path. The old
// design spawned `new URL(import.meta.url)`, but in the packaged app vite
// bundles this module into dist-electron/main.cjs, so the worker thread booted
// the whole application. Callers pass the built worker path
// (`inferenceWorkerPath`) instead; the sibling file is only inferred when this
// module itself is loaded as inferenceWorker.js.

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

export const END_OF_TURN = 'endOfTurn';
export const TONE = 'tone';

function asFloat32(samples) {
  if (samples instanceof Float32Array) return samples;
  if (samples && typeof samples.length === 'number') return Float32Array.from(samples);
  throw new Error('inference requests need a float sample array');
}

// A bundle such as dist-electron/main.cjs has no worker file next to it, so the
// sibling entry is inferred only from the unbundled source module's own URL.
export function resolveWorkerPath({ workerPath, metaUrl = import.meta.url } = {}) {
  if (typeof workerPath === 'string' && workerPath) return workerPath;
  if (typeof metaUrl === 'string' && metaUrl.startsWith('file:') && metaUrl.endsWith('inferenceWorker.js')) {
    return fileURLToPath(new URL('./inferenceWorkerThread.js', metaUrl));
  }
  throw new Error(
    'createPracticeInference requires workerPath: pass inferenceWorkerPath '
    + '(the built inferenceWorkerThread.js entry) from the caller',
  );
}

export function createPracticeInference({
  smartTurnPath,
  tonePath,
  workerPath,
  workerData,
  createWorker,
} = {}) {
  if (!smartTurnPath) throw new Error('createPracticeInference requires smartTurnPath');
  if (!tonePath) throw new Error('createPracticeInference requires tonePath');
  const resolvedPath = resolveWorkerPath({ workerPath });
  const spawn = typeof createWorker === 'function'
    ? createWorker
    // `workerData` carries extra thread data; tests use it to set fakeOrt.
    : (data) => new Worker(resolvedPath, { workerData: { ...workerData, ...data } });
  const worker = spawn({ smartTurnPath, tonePath });
  const pending = new Map();
  let nextId = 1;
  let closed = false;
  let failure = null;

  function settleAll(error) {
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) entry.reject(error);
  }

  worker.on('message', (message) => {
    if (!message || (message.type !== 'result' && message.type !== 'error')) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.type === 'error') entry.reject(new Error(message.message || 'inference failed'));
    else entry.resolve(message.value);
  });
  worker.on('error', (error) => {
    failure = error instanceof Error ? error : new Error(String(error));
    settleAll(failure);
  });
  worker.on('exit', () => {
    if (!closed) settleAll(new Error('inference worker exited'));
  });

  function request(kind, samples) {
    if (closed) return Promise.reject(new Error('practice inference is closed'));
    if (failure) return Promise.reject(failure);
    let array;
    try {
      array = asFloat32(samples);
    } catch (error) {
      return Promise.reject(error);
    }
    if (array.length === 0) return Promise.reject(new Error(`${kind} needs at least one sample`));
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ type: 'request', kind, id, samples: array }, [array.buffer]);
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }

  return {
    endOfTurn: (samples) => request(END_OF_TURN, samples),
    tone: (samples) => request(TONE, samples),
    async close() {
      if (closed) return;
      closed = true;
      settleAll(new Error('practice inference closed'));
      try {
        worker.postMessage({ type: 'close' });
      } catch {
        // worker already gone
      }
      if (typeof worker.terminate === 'function') await worker.terminate().catch(() => {});
    },
  };
}
