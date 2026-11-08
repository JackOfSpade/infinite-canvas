// Smart Turn v3: P(turn complete) from the last 8 s of 16 kHz mono audio.
// ONNX contract: input `input_features` float32 [1,80,800], output `logits`
// [1,1] which is already a probability.

import { extractWhisperFeatures, N_MELS, N_FRAMES } from './whisperFeatures.js';
import { createSessionHandle, firstOutput, makeTensor } from './onnxRuntime.js';

export const SMART_TURN_INPUT = 'input_features';
export const SMART_TURN_OUTPUT = 'logits';

export function createSmartTurn({ modelPath, ort } = {}) {
  const handle = createSessionHandle({ modelPath, ort });
  return {
    // samples16k: recent 16 kHz mono float samples of any length.
    async predict(samples16k) {
      const features = extractWhisperFeatures(samples16k);
      const { runtime, session } = await handle.get();
      const tensor = makeTensor(runtime, 'float32', features, [1, N_MELS, N_FRAMES]);
      const outputs = await session.run({ [SMART_TURN_INPUT]: tensor });
      const logits = firstOutput(outputs, SMART_TURN_OUTPUT);
      const value = Number(logits.data[0]);
      if (!Number.isFinite(value)) throw new Error('Smart Turn returned a non-finite logit');
      return value;
    },
    close: () => handle.close(),
  };
}
