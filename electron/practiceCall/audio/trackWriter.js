// Interviewer track rebuilt from what the engine sent and what the helper
// reported. Each utterance keeps its own PCM; events place the played spans on
// the helper timeline. File I/O only happens in finalize.
const SILENCE = 0;
const TWO_POW_15 = 32768;

function toSamples(pcm16le) {
  if (pcm16le instanceof Int16Array) return Float32Array.from(pcm16le, value => value / TWO_POW_15);
  if (typeof pcm16le === 'string') throw new Error('trackWriter: pcm16le must be bytes, not a string');
  let bytes = pcm16le;
  if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
  if (!bytes || typeof bytes.length !== 'number') throw new Error('trackWriter: pcm16le must be a byte buffer');
  const view = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length);
  const count = Math.floor(view.length / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) out[i] = view.readInt16LE(i * 2) / TWO_POW_15;
  return out;
}

const msToFrames = (ms, rate) => Math.round((ms * rate) / 1000);

function wavHeader(dataBytes, sampleRate) {
  const header = Buffer.alloc(44);
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

export function writePcm16Wav(filePath, samples, sampleRate, { fs }) {
  const fd = fs.openSync(filePath, 'w');
  try {
    const frames = samples.length;
    fs.writeSync(fd, wavHeader(frames * 2, sampleRate), 0, 44, 0);
    const blockFrames = sampleRate;
    let position = 44;
    for (let start = 0; start < frames; start += blockFrames) {
      const count = Math.min(blockFrames, frames - start);
      const chunk = Buffer.alloc(count * 2);
      for (let i = 0; i < count; i += 1) {
        const value = Math.max(-1, Math.min(1, samples[start + i]));
        chunk.writeInt16LE(Math.round(value * 32767), i * 2);
      }
      fs.writeSync(fd, chunk, 0, chunk.length, position);
      position += chunk.length;
    }
  } finally { fs.closeSync(fd); }
}

export function createInterviewerTrack({ sampleRate = 24000 } = {}) {
  if (!(sampleRate > 0)) throw new Error('trackWriter: sampleRate must be positive');
  const utterances = new Map();

  const require = id => {
    const utterance = utterances.get(id);
    if (!utterance) throw new Error(`trackWriter: unknown utterance ${String(id)}`);
    return utterance;
  };
  const closeSegment = (utterance, audioEndMs) => {
    const open = utterance.open;
    if (!open) return;
    utterance.segments.push({ wallStartMs: open.wallStartMs, audioStartMs: open.audioStartMs, audioEndMs: Math.max(open.audioStartMs, audioEndMs) });
    utterance.open = null;
  };

  return {
    addUtterance(id, pcm16le, rate) {
      if (!(rate > 0)) throw new Error('trackWriter: utterance sampleRate must be positive');
      const samples = toSamples(pcm16le);
      const durationMs = (samples.length * 1000) / rate;
      const existing = utterances.get(id);
      utterances.set(id, { samples, sampleRate: rate, durationMs, segments: existing?.segments ?? [], open: existing?.open ?? null });
    },
    started(id, atMs) {
      const utterance = require(id);
      if (utterance.open) closeSegment(utterance, utterance.durationMs);
      utterance.open = { wallStartMs: Math.max(0, atMs ?? 0), audioStartMs: 0 };
    },
    paused(id, positionMs, atMs) {
      const utterance = require(id);
      if (!utterance.open) throw new Error('trackWriter: paused before started');
      const position = Math.min(utterance.durationMs, Math.max(utterance.open.audioStartMs, positionMs ?? 0));
      closeSegment(utterance, position);
      utterance.resume = { positionMs: position, atMs: Math.max(0, atMs ?? 0) };
    },
    resumed(id, atMs) {
      const utterance = require(id);
      const resume = utterance.resume ?? { positionMs: utterance.segments.at(-1)?.audioEndMs ?? 0, atMs: 0 };
      utterance.resume = null;
      utterance.open = { wallStartMs: Math.max(0, atMs ?? resume.atMs), audioStartMs: resume.positionMs };
    },
    ended(id, positionMs, atMs) {
      const utterance = require(id);
      if (!utterance.open) return;
      const position = Math.min(utterance.durationMs, Math.max(utterance.open.audioStartMs, positionMs ?? utterance.durationMs));
      closeSegment(utterance, position);
      utterance.endedAtMs = Math.max(0, atMs ?? 0);
    },
    segments(id) {
      const utterance = require(id);
      return utterance.segments.map(segment => ({ ...segment }));
    },
    finalize(path, { durationMs, fs } = {}) {
      if (!fs) throw new Error('trackWriter: finalize requires fs');
      const duration = Math.max(0, Math.round(durationMs ?? 0));
      const frames = msToFrames(duration, sampleRate);
      const mix = new Float32Array(frames);
      for (const utterance of utterances.values()) {
        if (utterance.open) closeSegment(utterance, utterance.durationMs);
        for (const segment of utterance.segments) renderSegment(mix, utterance, segment, sampleRate);
      }
      writePcm16Wav(path, mix, sampleRate, { fs });
      return { durationMs: duration, sampleRate, frames, silence: SILENCE };
    },
  };
}

// Place one played span of one utterance into the output timeline, summing.
function renderSegment(mix, utterance, segment, targetRate) {
  const { samples, sampleRate: sourceRate } = utterance;
  const startSource = (segment.audioStartMs * sourceRate) / 1000;
  const spanSource = ((segment.audioEndMs - segment.audioStartMs) * sourceRate) / 1000;
  const spanTarget = Math.round((spanSource * targetRate) / sourceRate);
  const targetStart = msToFrames(segment.wallStartMs, targetRate);
  const step = sourceRate / targetRate;
  for (let k = 0; k < spanTarget; k += 1) {
    const out = targetStart + k;
    if (out < 0 || out >= mix.length) continue;
    const position = startSource + k * step;
    const index = Math.floor(position);
    if (index >= samples.length) break;
    const next = Math.min(index + 1, samples.length - 1);
    const fraction = position - index;
    mix[out] += samples[index] * (1 - fraction) + samples[next] * fraction;
  }
}

export default createInterviewerTrack;
