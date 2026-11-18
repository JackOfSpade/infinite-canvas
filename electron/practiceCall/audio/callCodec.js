// Runs interviewer audio through a real phone codec (Opus, VoIP mode) so it
// carries the band limit and light coding artefacts of a live call.
//
// Stream contract: process() returns exactly as many bytes as it is given.
// The audio comes out one 20 ms frame late (the first frame is silence), and
// flush() returns only what completes the byte count. Any failure turns the
// instance into a pass-through for the rest of its life (reported once) and
// never loses or adds a byte.
import { createRequire } from 'node:module';

// Constants from opus_defines.h (libopus 1.4).
export const OPUS_SET_BITRATE_REQUEST = 4002;
export const OPUS_SET_MAX_BANDWIDTH_REQUEST = 4004;
export const OPUS_BANDWIDTH_WIDEBAND = 1103; // 8 kHz audio bandwidth (16 kHz sampling)
export const CALL_CODEC_BITRATE = 24000;
export const CALL_CODEC_FRAME_MS = 20;
export const CALL_CODEC_RATES = Object.freeze([8000, 12000, 16000, 24000, 48000]);

// Synchronous default: a plain `require` inside the CJS main bundle (the
// package is an external there), createRequire when run as source in Node.
function defaultLoad() {
  if (typeof require === 'function') return require('opusscript');
  return createRequire(import.meta.url)('opusscript');
}

// Literal dynamic import for callers that resolve the package asynchronously
// (the bundled main process only follows import('literal')).
export async function loadOpusScript() {
  const mod = await import('opusscript');
  return mod.default || mod;
}

export function createCallCodec({ sampleRate, onError, load = defaultLoad } = {}) {
  const frameSamples = Math.round((sampleRate || 0) * CALL_CODEC_FRAME_MS / 1000);
  const frameBytes = frameSamples * 2;
  let mode = CALL_CODEC_RATES.includes(sampleRate) ? 'codec' : 'pass';
  let enc = null;
  let queue = Buffer.alloc(mode === 'codec' ? frameBytes : 0); // decoded audio waiting to go out (starts as one silent frame)
  let pending = Buffer.alloc(0); // input bytes not yet forming a whole frame
  let hold = Buffer.alloc(0); // after a failure: audio still owed, released one call late
  let silence = mode === 'codec' ? frameBytes : 0; // silent lead-in bytes still at the front of queue
  let debt = 0;
  let total = 0; // bytes in minus bytes out
  let reported = false;

  const report = err => {
    if (reported) return;
    reported = true;
    try { onError?.(err); } catch { /* a reporter must never break audio */ }
  };
  const free = () => {
    const e = enc; enc = null;
    try { e?.delete(); } catch { /* already gone */ }
  };
  const fail = err => {
    // Everything held (decoded queue plus raw pending) stays owed, so no byte is lost.
    hold = Buffer.concat([queue.subarray(silence), pending]); // the lead-in is not audio, so it is not owed
    debt = frameBytes - silence; // lead-in already sent displaced this much audio; the stream tail is dropped to keep the count
    silence = 0;
    queue = Buffer.alloc(0); pending = Buffer.alloc(0);
    mode = 'pass';
    free();
    report(err);
  };
  const ensure = () => {
    if (enc) return;
    const Ctor = load();
    const e = new Ctor(sampleRate, 1, Ctor.Application.VOIP);
    try {
      e.setBitrate(CALL_CODEC_BITRATE);
      e.encoderCTL(OPUS_SET_MAX_BANDWIDTH_REQUEST, OPUS_BANDWIDTH_WIDEBAND);
    } catch (err) { try { e.delete(); } catch { /* ignore */ } throw err; }
    enc = e;
  };
  const drain = (final) => {
    while (pending.length >= frameBytes || (final && pending.length > 0)) {
      let frame = pending.subarray(0, frameBytes);
      if (frame.length < frameBytes) frame = Buffer.concat([frame, Buffer.alloc(frameBytes - frame.length)]);
      const decoded = enc.decode(enc.encode(Buffer.from(frame), frameSamples));
      if (decoded.length !== frameBytes) throw new Error('codec frame size mismatch');
      queue = Buffer.concat([queue, decoded]);
      pending = pending.subarray(Math.min(frameBytes, pending.length));
    }
  };
  const passThrough = buffer => {
    if (!hold.length) return buffer;
    const all = Buffer.concat([hold, buffer]);
    hold = all.subarray(buffer.length);
    return all.subarray(0, buffer.length);
  };

  return {
    process(buffer) {
      if (!buffer || !buffer.length) return buffer || Buffer.alloc(0);
      if (mode === 'pass') return passThrough(buffer);
      pending = Buffer.concat([pending, buffer]);
      try {
        ensure();
        drain(false);
      } catch (err) {
        fail(err);
        // hold already contains this call's bytes: release the owed amount, keep the lead-in held.
        const out = hold.subarray(0, buffer.length);
        hold = hold.subarray(buffer.length);
        return out;
      }
      total += buffer.length;
      const out = queue.subarray(0, buffer.length);
      queue = queue.subarray(buffer.length);
      silence = Math.max(0, silence - buffer.length);
      total -= out.length;
      return Buffer.from(out);
    },
    flush() {
      if (mode === 'pass') { const h = hold.subarray(0, Math.max(0, hold.length - debt)); hold = Buffer.alloc(0); return h; }
      let out = Buffer.alloc(0);
      try {
        if (pending.length) { ensure(); drain(true); }
        // queue holds the silent lead-in plus decoded audio; owed bytes are what is left of the input.
        out = Buffer.from(queue.subarray(0, total));
      } catch (err) {
        const owed = total;
        fail(err);
        out = hold.subarray(0, owed); hold = Buffer.alloc(0); // hold is longer than owed by exactly the debt
        total = 0;
        return out;
      }
      queue = Buffer.alloc(0); pending = Buffer.alloc(0); total = 0;
      free();
      return out;
    },
    reset() {
      free();
      queue = Buffer.alloc(mode === 'codec' ? frameBytes : 0);
      silence = queue.length;
      pending = Buffer.alloc(0); hold = Buffer.alloc(0); total = 0; debt = 0;
    },
  };
}
