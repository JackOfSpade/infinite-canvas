// Cuts the start off finished call tracks.
// The recording begins when the audio helper starts, during setup and ringing, but the call
// begins when it is answered. Dropping that lead from both tracks puts the saved recording,
// the transcript and the chapters on one clock that starts at the answer.
// File I/O only, synchronous like the other track code; both files are read and checked
// before either is rewritten, so a bad track never leaves the pair cut unevenly.
import nodeFs from 'node:fs';

import { HEADER_BYTES } from './wavFormat.js';

function plan(path, startMs, fs) {
  const data = fs.readFileSync(path);
  if (data.length < HEADER_BYTES || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('trim: not a RIFF/WAVE file');
  }
  const sampleRate = data.readUInt32LE(24);
  const blockAlign = data.readUInt16LE(32);
  if (!sampleRate || !blockAlign) throw new Error('trim: unreadable WAV header');
  const bodyBytes = data.length - HEADER_BYTES;
  const skip = Math.min(bodyBytes - (bodyBytes % blockAlign), Math.floor((startMs * sampleRate) / 1000) * blockAlign);
  const body = data.subarray(HEADER_BYTES + skip);
  const header = Buffer.from(data.subarray(0, HEADER_BYTES));
  header.writeUInt32LE(36 + body.length, 4);
  header.writeUInt32LE(body.length, 40);
  return { path, bytes: Buffer.concat([header, body]) };
}

/** Remove the first `startMs` of every 44-byte-header PCM WAV in `paths`, in place. */
export function trimWavStart({ paths, startMs, fs = nodeFs } = {}) {
  const lead = Math.max(0, Math.round(Number(startMs) || 0));
  if (!Array.isArray(paths) || !paths.length) throw new Error('trim: no tracks given');
  if (!lead) return { trimmedMs: 0 };
  const plans = paths.map(path => plan(path, lead, fs));
  for (const item of plans) fs.writeFileSync(item.path, item.bytes);
  return { trimmedMs: lead };
}

export default trimWavStart;
