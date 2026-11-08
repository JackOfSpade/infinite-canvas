// Local tone model (audeering w2v2-L-robust-12): arousal/dominance/valence.
// ONNX contract: input `signal` float32 [1,N] raw samples (no normalisation),
// output `logits` [1,3] in the order arousal, dominance, valence (~0..1).

import { createSessionHandle, firstOutput, makeTensor } from './onnxRuntime.js';

export const TONE_INPUT = 'signal';
export const TONE_OUTPUT = 'logits';
export const TONE_DIMENSIONS = Object.freeze(['arousal', 'dominance', 'valence']);

function asFloat32(samples) {
  if (samples instanceof Float32Array) return samples;
  if (samples && typeof samples.length === 'number') return Float32Array.from(samples);
  throw new Error('tone model needs a float sample array');
}

export function createToneModel({ modelPath, ort } = {}) {
  const handle = createSessionHandle({ modelPath, ort });
  return {
    async score(samples16k) {
      const signal = asFloat32(samples16k);
      if (signal.length === 0) throw new Error('tone model needs at least one sample');
      const { runtime, session } = await handle.get();
      const tensor = makeTensor(runtime, 'float32', signal, [1, signal.length]);
      const outputs = await session.run({ [TONE_INPUT]: tensor });
      const logits = firstOutput(outputs, TONE_OUTPUT);
      const value = logits.data;
      if (!value || value.length < TONE_DIMENSIONS.length) {
        throw new Error('tone model returned fewer than three logits');
      }
      return {
        arousal: Number(value[0]),
        dominance: Number(value[1]),
        valence: Number(value[2]),
      };
    },
    close: () => handle.close(),
  };
}
