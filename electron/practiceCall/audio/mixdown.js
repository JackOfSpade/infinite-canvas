// Mix candidate and interviewer WAVs into one 24 kHz mono 16-bit track.
// Streamed in ~10 s blocks so a 45 minute call never sits in memory at once.
const OUT_RATE = 24000;
const HEADER_BYTES = 44;
const TWO_POW_15 = 32768;
const BLOCK_SECONDS = 10;

function readHeader(fd, fs, label) {
  const header = Buffer.alloc(HEADER_BYTES);
  if (fs.readSync(fd, header, 0, HEADER_BYTES, 0) < HEADER_BYTES) throw new Error(`mixdown: ${label} header incomplete`);
  if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`mixdown: ${label} is not a RIFF/WAVE file`);
  }
  const audioFormat = header.readUInt16LE(20);
  const channels = header.readUInt16LE(22);
  const sampleRate = header.readUInt32LE(24);
  const bits = header.readUInt16LE(34);
  if (audioFormat !== 1 || bits !== 16 || channels !== 1) {
    throw new Error(`mixdown: ${label} must be PCM16 mono, got format ${audioFormat} channels ${channels} bits ${bits}`);
  }
  return { sampleRate };
}

function openTrack(path, fs, label) {
  const fd = fs.openSync(path, 'r');
  try {
    const { sampleRate } = readHeader(fd, fs, label);
    const frames = Math.max(0, Math.floor((fs.fstatSync(fd).size - HEADER_BYTES) / 2));
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

function wavHeader(dataBytes, sampleRate) {
  const header = Buffer.alloc(HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

export function mixTracks({ candidatePath, interviewerPath, outPath, fs } = {}) {
  if (!fs) throw new Error('mixdown: mixTracks requires fs');
  const candidate = openTrack(candidatePath, fs, 'candidate');
  const interviewer = openTrack(interviewerPath, fs, 'interviewer');
  const durationMs = Math.max(candidate.durationMs, interviewer.durationMs);
  const totalFrames = Math.round((durationMs * OUT_RATE) / 1000);
  const blockFrames = OUT_RATE * BLOCK_SECONDS;
  const outFd = fs.openSync(outPath, 'w');
  try {
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
    fs.closeSync(outFd);
    fs.closeSync(candidate.fd);
    fs.closeSync(interviewer.fd);
  }
  return { durationMs, sampleRate: OUT_RATE, frames: totalFrames };
}

export default mixTracks;
