// ElevenLabs Flash time-to-first-audio (TTFA) probe over the stream-input WebSocket.
//
//   ELEVENLABS_API_KEY=... node voice-latency.mjs [--trials N] [--voice <voiceId>]
//
// The key is read ONLY from ELEVENLABS_API_KEY and is never printed or logged.
// Uses Node's global WebSocket (Node 22+); no dependencies.

import { pathToFileURL } from 'node:url';

// ---- API constants (verify against ElevenLabs' current WebSocket stream-input docs) ----
export const WS_HOST = 'wss://api.elevenlabs.io';
export const WS_PATH_TEMPLATE = '/v1/text-to-speech/{voice_id}/stream-input';
export const PARAM_MODEL_ID = 'model_id'; // query param
export const MODEL_ID = 'eleven_flash_v2_5';
export const PARAM_OUTPUT_FORMAT = 'output_format'; // query param
export const OUTPUT_FORMAT = 'pcm_16000'; // 16 kHz, 16-bit mono little-endian PCM
export const PARAM_SYNC_ALIGNMENT = 'sync_alignment'; // query param: alignment sent with each audio chunk
export const PCM_SAMPLE_RATE = 16000;
export const PCM_BYTES_PER_SAMPLE = 2;
// Auth: the docs allow `xi_api_key` in the first message (browser-style) or an `xi-api-key` header.
// Node's global WebSocket cannot set headers portably, so we use the first-message field.
export const AUTH_FIELD = 'xi_api_key';
// Premade voice "George", listed by /v2/voices as `premade` on this account.
// The older "Rachel" id is not available to a free-tier key over the API and
// failed every trial with payment_required (measured 2026-11-07).
export const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';
export const DEFAULT_VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.8, use_speaker_boost: false };
export const INTERVIEWER_SENTENCE = 'Thanks for joining me today. Could you start by telling me about a project you are proud of?';
export const TRIAL_TIMEOUT_MS = 15000;

export function buildUrl(voiceId = DEFAULT_VOICE_ID) {
  const params = new URLSearchParams({
    [PARAM_MODEL_ID]: MODEL_ID,
    [PARAM_OUTPUT_FORMAT]: OUTPUT_FORMAT,
    [PARAM_SYNC_ALIGNMENT]: 'true',
  });
  return `${WS_HOST}${WS_PATH_TEMPLATE.replace('{voice_id}', encodeURIComponent(voiceId))}?${params}`;
}

/** First message: a single space primes the stream; carries voice settings and auth. */
export function buildInitMessage(apiKey, voiceSettings = DEFAULT_VOICE_SETTINGS) {
  return { text: ' ', voice_settings: voiceSettings, [AUTH_FIELD]: apiKey };
}

/** Text message; trailing space is required by the API; flush forces immediate generation. */
export function buildTextMessage(text, { flush = true } = {}) {
  const spaced = text.endsWith(' ') ? text : `${text} `;
  return flush ? { text: spaced, flush: true } : { text: spaced };
}

/** End-of-input message. */
export function buildCloseMessage() {
  return { text: '' };
}

export function audioMsFromBytes(bytes) {
  return (bytes / PCM_BYTES_PER_SAMPLE / PCM_SAMPLE_RATE) * 1000;
}

/** Inspect one parsed server message. */
export function inspectServerMessage(msg) {
  const audioBase64 = typeof msg?.audio === 'string' && msg.audio.length > 0 ? msg.audio : null;
  const audioBytes = audioBase64 ? Buffer.from(audioBase64, 'base64').length : 0;
  const hasChars = (a) => Array.isArray(a?.chars) && a.chars.length > 0;
  return {
    audioBytes,
    hasAlignment: hasChars(msg?.alignment) || hasChars(msg?.normalizedAlignment),
    isFinal: msg?.isFinal === true,
    error: typeof msg?.error === 'string' ? msg.error : typeof msg?.message === 'string' && msg?.code ? msg.message : null,
  };
}

/** Nearest-rank percentile (p in 0..100) over numbers; null for empty input. */
export function percentile(values, p) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);

export function summarizeTrials(trials) {
  const ok = trials.filter((t) => !t.error && Number.isFinite(t.ttfaMs));
  const col = (key) => ok.map((t) => t[key]);
  return {
    trials: trials.length,
    succeeded: ok.length,
    failed: trials.length - ok.length,
    ttfaMs: { p50: round1(percentile(col('ttfaMs'), 50)), p95: round1(percentile(col('ttfaMs'), 95)), min: round1(percentile(col('ttfaMs'), 0)), max: round1(percentile(col('ttfaMs'), 100)) },
    connectMs: { p50: round1(percentile(col('connectMs'), 50)), p95: round1(percentile(col('connectMs'), 95)) },
    finalMs: { p50: round1(percentile(col('finalMs'), 50)), p95: round1(percentile(col('finalMs'), 95)) },
    alignmentArrivedInTrials: ok.filter((t) => t.alignment).length,
    totalAudioMs: { p50: round1(percentile(col('audioMs'), 50)) },
    errors: trials.filter((t) => t.error).map((t) => t.error),
  };
}

export function parseArgs(argv) {
  const out = { trials: 5, voice: DEFAULT_VOICE_ID };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--trials') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('--trials must be an integer 1..100');
      out.trials = n;
    } else if (argv[i] === '--voice') {
      const v = argv[++i];
      if (!v || !/^[A-Za-z0-9]+$/.test(v)) throw new Error('--voice must be an alphanumeric voice id');
      out.voice = v;
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return out;
}

/** Remove any occurrence of the key from a string. */
export function scrub(text, apiKey) {
  const s = String(text ?? '');
  return apiKey ? s.split(apiKey).join('[redacted]') : s;
}

async function messageText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof Blob) return data.text();
  return Buffer.from(data).toString('utf8');
}

export function runTrial({ apiKey, voiceId, text = INTERVIEWER_SENTENCE, timeoutMs = TRIAL_TIMEOUT_MS, WebSocketImpl = globalThis.WebSocket }) {
  return new Promise((resolve) => {
    const result = { connectMs: null, ttfaMs: null, finalMs: null, alignment: false, audioMs: 0, error: null };
    const t0 = performance.now();
    let sentAt = null;
    let audioBytes = 0;
    let settled = false;
    let ws;
    const done = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      result.audioMs = round1(audioMsFromBytes(audioBytes));
      if (error) result.error = scrub(error, apiKey);
      try { ws?.close(); } catch { /* ignore */ }
      resolve(result);
    };
    const timer = setTimeout(() => done('timeout'), timeoutMs);
    try {
      ws = new WebSocketImpl(buildUrl(voiceId));
    } catch (e) {
      done(`connect-failed: ${e?.message ?? e}`);
      return;
    }
    ws.addEventListener('open', () => {
      result.connectMs = round1(performance.now() - t0);
      ws.send(JSON.stringify(buildInitMessage(apiKey)));
      sentAt = performance.now();
      ws.send(JSON.stringify(buildTextMessage(text, { flush: true })));
      ws.send(JSON.stringify(buildCloseMessage()));
    });
    ws.addEventListener('message', async (event) => {
      const now = performance.now();
      let parsed;
      try { parsed = JSON.parse(await messageText(event.data)); } catch { return; }
      const info = inspectServerMessage(parsed);
      if (info.error) { done(`server-error: ${info.error}`); return; }
      if (info.audioBytes > 0) {
        if (result.ttfaMs === null && sentAt !== null) result.ttfaMs = round1(now - sentAt);
        audioBytes += info.audioBytes;
      }
      if (info.hasAlignment) result.alignment = true;
      if (info.isFinal) {
        result.finalMs = round1(now - (sentAt ?? t0));
        done(null);
      }
    });
    ws.addEventListener('error', () => done('websocket-error'));
    ws.addEventListener('close', (event) => {
      if (!settled) done(result.ttfaMs !== null ? null : `closed-early code=${event?.code ?? '?'}`);
    });
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const apiKey = env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.error('ELEVENLABS_API_KEY is not set; refusing to run.');
    return 2;
  }
  if (typeof globalThis.WebSocket !== 'function') {
    console.error('Global WebSocket is unavailable; Node 22+ is required.');
    return 2;
  }
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  const trials = [];
  for (let i = 0; i < args.trials; i += 1) {
    const trial = await runTrial({ apiKey, voiceId: args.voice });
    trials.push(trial);
    console.error(`trial ${i + 1}/${args.trials}: ttfa=${trial.ttfaMs ?? 'n/a'}ms${trial.error ? ` error=${trial.error}` : ''}`);
  }
  console.log(JSON.stringify({
    model: MODEL_ID, outputFormat: OUTPUT_FORMAT, voice: args.voice, sentence: INTERVIEWER_SENTENCE,
    summary: summarizeTrials(trials), trials,
  }, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
