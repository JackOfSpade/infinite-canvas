/**
 * Verbatim speech-to-text for the interview recording (ElevenLabs Scribe).
 * Words keep fillers and false starts: `no_verbatim` stays false.
 */
import { classifyFailure, voiceError, redact } from './dialogueVoice.js';

export const SCRIBE_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
export const SCRIBE_MODEL = 'scribe_v2';
export const TIMESTAMP_GRANULARITY = 'word';

const basename = filePath => String(filePath ?? '').split(/[\\/]/).pop() || 'audio.wav';

const MIME_BY_EXTENSION = {
  wav: 'audio/wav', m4a: 'audio/mp4', mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'audio/webm', ogg: 'audio/ogg',
};

export const mimeFor = filePath => MIME_BY_EXTENSION[basename(filePath).split('.').pop()?.toLowerCase()] ?? 'application/octet-stream';

const toBytes = data => {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
};

async function readBytes(fs, filePath) {
  if (!fs) throw voiceError('voice-protocol', 'no file system provided for transcription');
  try {
    if (fs.promises?.readFile) return toBytes(await fs.promises.readFile(filePath));
    if (typeof fs.readFile === 'function') {
      return await new Promise((resolve, reject) => {
        fs.readFile(filePath, (error, data) => (error ? reject(error) : resolve(toBytes(data))));
      });
    }
    if (typeof fs.readFileSync === 'function') return toBytes(fs.readFileSync(filePath));
  } catch (cause) {
    throw voiceError('voice-protocol', 'could not read the audio file', { cause });
  }
  throw voiceError('voice-protocol', 'no file system provided for transcription');
}

export function wordsFromResponse(body) {
  const words = Array.isArray(body?.words) ? body.words : [];
  const ms = value => {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number * 1000) : null;
  };
  return words.map(word => ({
    text: String(word?.text ?? ''),
    startMs: ms(word?.start),
    endMs: ms(word?.end),
    type: String(word?.type ?? 'word'),
  }));
}

/**
 * @param {object} options
 * @param {string} options.path audio file on disk
 * @param {Function} [options.fetch]
 * @param {string} options.key API key; never echoed
 * @param {object} [options.fs] node:fs compatible module
 */
export async function transcribeVerbatim({
  path: filePath, fetch = globalThis.fetch, key, fs, url = SCRIBE_URL, signal,
} = {}) {
  if (!key) throw voiceError('voice-auth', 'no ElevenLabs API key');
  const bytes = await readBytes(fs, filePath);
  if (!bytes?.length) throw voiceError('voice-protocol', 'the audio file is empty');
  const form = new FormData();
  const name = basename(filePath);
  form.append('file', new Blob([bytes], { type: mimeFor(filePath) }), name);
  form.append('model_id', SCRIBE_MODEL);
  form.append('timestamps_granularity', TIMESTAMP_GRANULARITY);
  form.append('tag_audio_events', 'false');
  form.append('no_verbatim', 'false');
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers: { 'xi-api-key': key }, body: form, signal });
  } catch (cause) {
    throw voiceError('voice-network', 'transcription request failed', { cause });
  }
  if (!response?.ok) {
    const status = Number(response?.status) || 0;
    let detail = '';
    try {
      const body = await response.json();
      detail = typeof body?.detail === 'string' ? body.detail : '';
    } catch { detail = ''; }
    const code = classifyFailure({ status, message: detail });
    throw voiceError(code, redact(`transcription request failed (HTTP ${status})`, key), { status });
  }
  let body;
  try { body = await response.json(); } catch (cause) {
    throw voiceError('voice-protocol', 'transcription response was not JSON', { cause });
  }
  return {
    text: String(body?.text ?? ''),
    language: String(body?.language_code ?? ''),
    words: wordsFromResponse(body),
  };
}

export default transcribeVerbatim;
