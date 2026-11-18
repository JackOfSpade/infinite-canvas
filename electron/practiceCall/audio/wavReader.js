// Growing WAV reader for the practice helper's timeline.
// The helper writes a 44-byte header PCM16 mono file and keeps appending to it,
// so every read re-checks the bytes actually written and clamps to them.
// File I/O only: everything else in audio/ is pure JS on Float32Arrays.
import nodeFs from 'node:fs';

import { HEADER_BYTES, TWO_POW_15, pcm16FrameCount, readPcm16MonoHeader } from './wavFormat.js';

export { HEADER_BYTES };

export function openGrowingWav(path, { fs = nodeFs } = {}) {
  const fd = fs.openSync(path, 'r');
  let header;
  try { header = readPcm16MonoHeader(fd, fs, { prefix: 'practice call wav' }); }
  catch (error) { try { fs.closeSync(fd); } catch { /* already closed */ } throw error; }
  const { sampleRate } = header;
  let closed = false;

  const writtenFrames = () => {
    let size = 0;
    try { size = fs.fstatSync(fd).size; } catch { size = 0; }
    return pcm16FrameCount(size);
  };

  return {
    sampleRate,
    writtenMs() { return (writtenFrames() * 1000) / sampleRate; },
    readMs(startMs, endMs) {
      const written = writtenFrames();
      const totalMs = (written * 1000) / sampleRate;
      const from = Math.max(0, Math.min(Math.round(startMs ?? 0), totalMs));
      const to = Math.max(from, Math.min(Math.round(endMs ?? totalMs), totalMs));
      const startSample = Math.floor((from * sampleRate) / 1000);
      const endSample = Math.min(written, Math.floor((to * sampleRate) / 1000));
      const frames = Math.max(0, endSample - startSample);
      if (!frames) return new Float32Array(0);
      const raw = Buffer.alloc(frames * 2);
      let got = 0;
      while (got < raw.length) {
        const n = fs.readSync(fd, raw, got, raw.length - got, HEADER_BYTES + (startSample + got / 2) * 2);
        if (n <= 0) break;
        got += n;
      }
      const out = new Float32Array(got >> 1);
      for (let i = 0; i < out.length; i += 1) {
        const value = raw.readInt16LE(i * 2);
        out[i] = value / TWO_POW_15;
      }
      return out;
    },
    close() {
      if (closed) return;
      closed = true;
      fs.closeSync(fd);
    },
  };
}

export default openGrowingWav;
