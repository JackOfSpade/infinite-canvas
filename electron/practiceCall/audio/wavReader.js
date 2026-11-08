// Growing WAV reader for the practice helper's timeline.
// The helper writes a 44-byte header PCM16 mono file and keeps appending to it,
// so every read re-checks the bytes actually written and clamps to them.
// File I/O only: everything else in audio/ is pure JS on Float32Arrays.
import nodeFs from 'node:fs';

export const HEADER_BYTES = 44;
const TWO_POW_15 = 32768;

function u32(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
}
function u16(bytes, offset) { return bytes[offset] | (bytes[offset + 1] << 8); }

function readHeader(fd, fs) {
  const header = Buffer.alloc(HEADER_BYTES);
  const read = fs.readSync(fd, header, 0, HEADER_BYTES, 0);
  if (read < HEADER_BYTES) throw new Error('practice call wav: header incomplete');
  if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('practice call wav: not a RIFF/WAVE file');
  }
  const audioFormat = u16(header, 20);
  const channels = u16(header, 22);
  const sampleRate = u32(header, 24);
  const bitsPerSample = u16(header, 34);
  if (audioFormat !== 1 || bitsPerSample !== 16 || channels !== 1) {
    throw new Error(`practice call wav: expected PCM16 mono, got format ${audioFormat} channels ${channels} bits ${bitsPerSample}`);
  }
  return { sampleRate, channels };
}

export function openGrowingWav(path, { fs = nodeFs } = {}) {
  const fd = fs.openSync(path, 'r');
  let header;
  try { header = readHeader(fd, fs); }
  catch (error) { try { fs.closeSync(fd); } catch { /* already closed */ } throw error; }
  const { sampleRate } = header;
  let closed = false;

  const writtenFrames = () => {
    let size = 0;
    try { size = fs.fstatSync(fd).size; } catch { size = 0; }
    return Math.max(0, Math.floor((size - HEADER_BYTES) / 2));
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
