// Worker-thread entry for the practice-call inference worker: one thread owns
// both ONNX sessions and serves a two-level queue in which a queued endOfTurn
// request is always served before a queued tone request. This file is
// self-contained (it never imports the host module) so the app bundle can
// build it as its own entry and the host can spawn it by path. The model
// modules load onnxruntime-node lazily, only when a session is first used.
//
// workerData: { smartTurnPath, tonePath, fakeOrt? }.
// `fakeOrt` is TEST ONLY: `true` (or `{ toneDelayMs, endOfTurnDelayMs }`) swaps
// the onnxruntime-node import for the in-file fake session factory below, which
// answers with fixed logits after a short delay. Production never sets it.

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createSmartTurn } from './smartTurn.js';
import { createToneModel } from './toneModel.js';

export const END_OF_TURN = 'endOfTurn';
export const TONE = 'tone';
const REQUEST_KINDS = new Set([END_OF_TURN, TONE]);

export const FAKE_TURN_LOGIT = 0.75;
// Exactly representable as float32, so a round trip compares with deepEqual.
export const FAKE_TONE_SCORES = Object.freeze({ arousal: 0.5, dominance: 0.25, valence: 0.75 });

function delayMs(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// Worker-side scheduling core. A single request runs at a time; between
// requests the endOfTurn queue is always drained before the tone queue.
export function createRequestQueue({ runEndOfTurn, runTone, onResult, onError }) {
  const queues = { [END_OF_TURN]: [], [TONE]: [] };
  let busy = false;
  let stopped = false;

  async function pump() {
    if (busy || stopped) return;
    const next = queues[END_OF_TURN].shift() ?? queues[TONE].shift();
    if (!next) return;
    busy = true;
    try {
      const value = next.kind === END_OF_TURN
        ? await runEndOfTurn(next.samples)
        : await runTone(next.samples);
      if (!stopped) onResult(next.id, value);
    } catch (error) {
      if (!stopped) onError(next.id, error);
    } finally {
      busy = false;
      await pump();
    }
  }

  return {
    push(kind, id, samples) {
      if (stopped) return;
      const queue = queues[kind];
      if (!queue) throw new Error(`unknown request kind: ${kind}`);
      queue.push({ kind, id, samples });
      void pump();
    },
    pending() {
      return queues[END_OF_TURN].length + queues[TONE].length + (busy ? 1 : 0);
    },
    idle() {
      return !busy && queues[END_OF_TURN].length === 0 && queues[TONE].length === 0;
    },
    stop() {
      stopped = true;
      queues[END_OF_TURN].length = 0;
      queues[TONE].length = 0;
    },
  };
}

// TEST ONLY. An onnxruntime-node stand-in with the same Tensor/InferenceSession
// surface, so the real models and the real worker loop run without the native
// runtime. Smart Turn feeds `input_features`, the tone model feeds `signal`;
// both read `logits`, so the feeds pick the answer.
export function createFakeOrt({ toneDelayMs = 40, endOfTurnDelayMs = 5 } = {}) {
  class Tensor {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }
  const InferenceSession = {
    async create(modelPath) {
      return {
        modelPath,
        async run(feeds) {
          if (feeds?.signal) {
            await delayMs(toneDelayMs);
            const scores = FAKE_TONE_SCORES;
            const data = Float32Array.from([scores.arousal, scores.dominance, scores.valence]);
            return { logits: new Tensor('float32', data, [1, 3]) };
          }
          await delayMs(endOfTurnDelayMs);
          return { logits: new Tensor('float32', Float32Array.from([FAKE_TURN_LOGIT]), [1, 1]) };
        },
        async release() {},
      };
    },
  };
  return { Tensor, InferenceSession };
}

function fakeOrtOptions(flag) {
  if (flag === true) return {};
  if (flag && typeof flag === 'object') return flag;
  return null;
}

// Serves `port` with both models; the host side lives in inferenceWorker.js.
export function startInferenceWorker({ port, data = {} } = {}) {
  if (!port) throw new Error('startInferenceWorker requires a port');
  const fake = fakeOrtOptions(data.fakeOrt);
  const ort = fake ? createFakeOrt(fake) : undefined;
  let smartTurnPromise = null;
  let tonePromise = null;
  const smartTurn = () => {
    smartTurnPromise ||= Promise.resolve().then(() => createSmartTurn({ modelPath: data.smartTurnPath, ort }));
    return smartTurnPromise;
  };
  const tone = () => {
    tonePromise ||= Promise.resolve().then(() => createToneModel({ modelPath: data.tonePath, ort }));
    return tonePromise;
  };
  const queue = createRequestQueue({
    runEndOfTurn: async (samples) => (await smartTurn()).predict(samples),
    runTone: async (samples) => (await tone()).score(samples),
    onResult: (id, value) => port.postMessage({ type: 'result', id, value }),
    onError: (id, error) => port.postMessage({ type: 'error', id, message: error?.message || String(error) }),
  });
  port.on('message', (message) => {
    if (!message) return;
    if (message.type === 'request' && REQUEST_KINDS.has(message.kind)) {
      queue.push(message.kind, message.id, message.samples);
      return;
    }
    if (message.type === 'close') {
      queue.stop();
      Promise.allSettled([
        smartTurnPromise ? smartTurnPromise.then((model) => model.close()) : null,
        tonePromise ? tonePromise.then((model) => model.close()) : null,
      ]).then(() => port.close());
    }
  });
  return queue;
}

if (!isMainThread && parentPort) startInferenceWorker({ port: parentPort, data: workerData || {} });
