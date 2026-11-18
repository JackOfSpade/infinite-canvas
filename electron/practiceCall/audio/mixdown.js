// Mix candidate and interviewer WAVs into one 24 kHz mono 16-bit track.
// Streamed in ~10 s blocks so a 45 minute call never sits in memory at once.
import { HEADER_BYTES, TWO_POW_15, wavHeader, pcm16FrameCount, readPcm16MonoHeader } from './wavFormat.js';

const OUT_RATE = 24000;
const BLOCK_SECONDS = 10;

function openTrack(path, fs, label) {
  const fd = fs.openSync(path, 'r');
  try {
    const { sampleRate } = readPcm16MonoHeader(fd, fs, { prefix: 'mixdown', subject: label });
    const frames = pcm16FrameCount(fs.fstatSync(fd).size);
    return { fd, sampleRate, frames, durationMs: Math.round((frames * 1000) / sampleRate) };
  } catch (error) { fs.closeSync(fd); throw error; }
}

// Reads source frames [startFrame, startFrame + count) as Float32.
function readFrames(track, fs, startFrame, count) {
  const out = new Float32Array(count);
  const available = Math.max(0, Math.min(count, track.frames - startFrame));
  if (available <= 0) return out;
  const raw = Buffer.alloc(available * 2);
  let got = 0;
  while (got < raw.length) {
    const read = fs.readSync(track.fd, raw, got, raw.length - got, HEADER_BYTES + (startFrame + got / 2) * 2);
    if (read <= 0) break;
    got += read;
  }
  for (let i = 0; i < got >> 1; i += 1) out[i] = raw.readInt16LE(i * 2) / TWO_POW_15;
  return out;
}

function mixBlock(outFrames, offset, fs, candidate, interviewer) {
  const target = new Float32Array(outFrames);
  const addTrack = track => {
    const ratio = track.sampleRate / OUT_RATE;
    const sourceStart = Math.max(0, Math.floor(offset * ratio));
    const sourceEnd = Math.min(track.frames, Math.ceil((offset + outFrames) * ratio) + 2);
    const source = readFrames(track, fs, sourceStart, Math.max(0, sourceEnd - sourceStart));
    for (let i = 0; i < outFrames; i += 1) {
      const position = (offset + i) * ratio - sourceStart;
      const index = Math.floor(position);
      if (index < 0 || index >= source.length) continue;
      const next = Math.min(index + 1, source.length - 1);
      target[i] += source[index] * (1 - (position - index)) + source[next] * (position - index);
    }
  };
  addTrack(candidate);
  addTrack(interviewer);
  return target;
}

export function mixTracks({ candidatePath, interviewerPath, outPath, fs } = {}) {
  if (!fs) throw new Error('mixdown: mixTracks requires fs');
  const candidate = openTrack(candidatePath, fs, 'candidate');
  let interviewer;
  try {
    interviewer = openTrack(interviewerPath, fs, 'interviewer');
  } catch (error) {
    fs.closeSync(candidate.fd);
    throw error;
  }
  const durationMs = Math.max(candidate.durationMs, interviewer.durationMs);
  const totalFrames = Math.round((durationMs * OUT_RATE) / 1000);
  const blockFrames = OUT_RATE * BLOCK_SECONDS;
  let outFd;
  try {
    outFd = fs.openSync(outPath, 'w');
    fs.writeSync(outFd, wavHeader(totalFrames * 2, OUT_RATE), 0, HEADER_BYTES, 0);
    let position = HEADER_BYTES;
    for (let offset = 0; offset < totalFrames; offset += blockFrames) {
      const count = Math.min(blockFrames, totalFrames - offset);
      const block = mixBlock(count, offset, fs, candidate, interviewer);
      const chunk = Buffer.alloc(count * 2);
      for (let i = 0; i < count; i += 1) {
        const value = Math.max(-1, Math.min(1, Math.tanh(block[i])));
        chunk.writeInt16LE(Math.round(value * 32767), i * 2);
      }
      fs.writeSync(outFd, chunk, 0, chunk.length, position);
      position += chunk.length;
    }
  } finally {
    if (outFd !== undefined) fs.closeSync(outFd);
    fs.closeSync(candidate.fd);
    fs.closeSync(interviewer.fd);
  }
  return { durationMs, sampleRate: OUT_RATE, frames: totalFrames };
}

export default mixTracks;
