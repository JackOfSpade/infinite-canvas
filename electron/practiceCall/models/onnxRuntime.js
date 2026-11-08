// Small shared ONNX plumbing: lazy runtime loading, session lifecycle and
// output extraction. onnxruntime-node is only imported when no ort is injected.

let defaultOrtPromise = null;

export function loadOrt(ort) {
  if (ort) return Promise.resolve(ort);
  if (!defaultOrtPromise) defaultOrtPromise = import('onnxruntime-node');
  return defaultOrtPromise;
}

export function makeTensor(runtime, type, data, dims) {
  const Tensor = runtime?.Tensor;
  if (typeof Tensor !== 'function') throw new Error('ort.Tensor is required');
  return new Tensor(type, data, dims);
}

export function firstOutput(outputs, preferred) {
  if (!outputs) throw new Error('model returned no outputs');
  if (preferred && outputs[preferred]) return outputs[preferred];
  const keys = Object.keys(outputs);
  if (keys.length === 0) throw new Error('model returned no outputs');
  return outputs[keys[0]];
}

// createSessionHandle({ modelPath, ort }).get() -> { runtime, session };
// the session is created at most once and released by close().
export function createSessionHandle({ modelPath, ort } = {}) {
  if (!modelPath) throw new Error('modelPath is required');
  let runtime = null;
  let sessionPromise = null;
  let closed = false;
  async function get() {
    if (closed) throw new Error('model session is closed');
    if (!runtime) runtime = await loadOrt(ort);
    if (!sessionPromise) {
      sessionPromise = Promise.resolve(runtime.InferenceSession.create(modelPath));
      sessionPromise.catch(() => { sessionPromise = null; });
    }
    return { runtime, session: await sessionPromise };
  }
  return {
    get,
    isClosed: () => closed,
    async close() {
      closed = true;
      const pending = sessionPromise;
      sessionPromise = null;
      if (!pending) return;
      const session = await pending.catch(() => null);
      if (!session) return;
      if (typeof session.release === 'function') await session.release();
      else if (typeof session.close === 'function') await session.close();
    },
  };
}
