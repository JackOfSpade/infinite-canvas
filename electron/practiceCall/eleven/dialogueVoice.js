/**
 * ElevenLabs Text to Dialogue voice for the interview practice call.
 * One WebSocket per utterance, one registered voice, PCM audio at the account's rate.
 * Every dependency (WebSocket class, clock, key) is injected; nothing is logged.
 */
export const MODEL_ID = 'eleven_v4_turbo';
export const SOCKET_URL = 'wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input';
export const SUBSCRIPTION_URL = 'https://api.elevenlabs.io/v1/user/subscription';
export const PAID_RATE = 44100;
export const FREE_RATE = 24000;
export const FALLBACK_RATE = 24000;
// The server drops a connection after 20 s of silence; stay well below it.
export const KEEP_ALIVE_MS = 15000;

export const VOICE_ERROR_CODES = Object.freeze(['voice-auth', 'voice-quota', 'voice-network', 'voice-protocol']);

export const outputFormat = rate => `pcm_${rate}`;

export function voiceError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = VOICE_ERROR_CODES.includes(code) ? code : 'voice-protocol';
  Object.assign(error, extra);
  return error;
}

/** 44.1 kHz only on a known paid plan; free (and unknown) tiers get 24 kHz. */
export function rateForTier(tier) {
  const value = String(tier ?? '').trim().toLowerCase();
  if (!value || value === 'free') return FREE_RATE;
  return PAID_RATE;
}

/** GET /v1/user/subscription → tier string. Errors are mapped, never echoed with the key. */
export async function fetchSubscriptionTier({ fetch = globalThis.fetch, key, url = SUBSCRIPTION_URL, signal } = {}) {
  let response;
  try {
    response = await fetch(url, { headers: { 'xi-api-key': key }, signal });
  } catch (cause) {
    throw voiceError('voice-network', 'subscription request failed', { cause });
  }
  if (!response?.ok) throw statusError(response, 'subscription request failed', key);
  let body;
  try {
    body = await response.json();
  } catch (cause) {
    throw voiceError('voice-protocol', 'subscription response was not JSON', { cause });
  }
  return String(body?.tier ?? '').trim();
}

const AUTH_WORDS = /(invalid|missing|expired|incorrect).?(api.?key|token)|unauthor|authentication|not.?(authorised|authorized)|permission/i;
const QUOTA_WORDS = /quota|credit|rate.?limit|usage.?limit|too.?many.?requests/i;
const RATE_WORDS = /output.?format|pcm|sample.?(rate|frequency)|44\.?1|44100|48.?k|unsupported.?format/i;

export const isAuthText = text => AUTH_WORDS.test(String(text ?? ''));
export const isQuotaText = text => QUOTA_WORDS.test(String(text ?? ''));
export const isRateRejection = ({ code, reason, message } = {}) => {
  const text = `${reason ?? ''} ${message ?? ''}`;
  if (isAuthText(text) || isQuotaText(text)) return false;
  if (code === 1003) return true;
  return RATE_WORDS.test(text);
};

/** Maps an HTTP failure, close reason or server error frame onto the small code set. */
export function classifyFailure({ status, reason, message, code } = {}) {
  if (status === 401 || status === 403) return isQuotaText(message) ? 'voice-quota' : 'voice-auth';
  if (status === 429) return 'voice-quota';
  const text = `${reason ?? ''} ${message ?? ''}`;
  if (isQuotaText(text)) return 'voice-quota';
  if (isAuthText(text)) return 'voice-auth';
  if (!status && (code === 1006 || code === 1005)) return 'voice-network';
  return 'voice-protocol';
}

function statusError(response, prefix, key) {
  const status = Number(response?.status) || 0;
  const code = classifyFailure({ status, message: '' });
  const detail = status ? ` (HTTP ${status})` : '';
  return voiceError(code, `${prefix}${detail}`.replace(key ? new RegExp(escapeRegExp(key), 'g') : /$^/, '[redacted]'), { status });
}

export const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Never let the API key reach an error message. */
export function redact(value, key) {
  const text = String(value ?? '');
  if (!key) return text;
  return text.split(String(key)).join('[redacted]');
}

const roundMs = value => Math.round(Number(value) * 10) / 10;

/**
 * Character alignment of one chunk → whole words at absolute utterance time.
 * `offsetMs` is the decoded duration of the PCM delivered before this chunk.
 */
export function wordsFromAlignment(alignment, offsetMs = 0) {
  if (!alignment) return [];
  const chars = Array.isArray(alignment.chars) ? alignment.chars : [];
  const starts = Array.isArray(alignment.char_start_times_ms) ? alignment.char_start_times_ms : [];
  const durations = Array.isArray(alignment.char_durations_ms) ? alignment.char_durations_ms : [];
  const words = [];
  let current = null;
  for (let index = 0; index < chars.length; index += 1) {
    const char = String(chars[index] ?? '');
    if (!char) continue;
    if (/\s/.test(char)) {
      if (current) { words.push(current); current = null; }
      continue;
    }
    const start = Number(starts[index]);
    const duration = Number(durations[index]);
    const hasStart = Number.isFinite(start);
    const startMs = hasStart ? offsetMs + start : (current ? current.startMs : offsetMs);
    const endMs = hasStart && Number.isFinite(duration) ? offsetMs + start + Math.max(0, duration) : startMs;
    if (!current) current = { word: char, startMs: roundMs(startMs), endMs: roundMs(endMs) };
    else {
      current.word += char;
      current.endMs = roundMs(Math.max(current.endMs, endMs));
    }
  }
  if (current) words.push(current);
  return words;
}

/** Duration in ms of 16-bit LE mono PCM at `sampleRate`. */
export const pcmDurationMs = (bytes, sampleRate) => (bytes / 2 / sampleRate) * 1000;

const toBuffer = data => {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
};

const messageText = data => (typeof data === 'string' ? data : (toBuffer(data)?.toString('utf8') ?? ''));

function parseFrame(data) {
  const text = messageText(data);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export function socketUrl(rate, base = SOCKET_URL) {
  const url = new URL(base);
  url.searchParams.set('model_id', MODEL_ID);
  url.searchParams.set('output_format', outputFormat(rate));
  url.searchParams.set('sync_alignment', 'true');
  return url.toString();
}

/** Binds the three socket events, working with both addEventListener and on* sockets. */
function bindSocket(socket, handlers) {
  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener('open', handlers.open);
    socket.addEventListener('message', handlers.message);
    socket.addEventListener('error', handlers.error);
    socket.addEventListener('close', handlers.close);
    return;
  }
  socket.onopen = handlers.open;
  socket.onmessage = handlers.message;
  socket.onerror = handlers.error;
  socket.onclose = handlers.close;
}

/**
 * One voice stream per utterance. `open` is synchronous so `sampleRate` is known before any
 * audio flows; the socket itself connects in the background.
 */
export function createDialogueVoiceFactory({
  key,
  voiceId,
  tier = 'free',
  WebSocket = globalThis.WebSocket,
  url = SOCKET_URL,
  keepAliveMs = KEEP_ALIVE_MS,
  clock = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: handle => clearTimeout(handle),
  },
} = {}) {
  if (!key) throw voiceError('voice-auth', 'no ElevenLabs API key');
  if (!voiceId) throw voiceError('voice-protocol', 'no voice configured');
  if (typeof WebSocket !== 'function') throw voiceError('voice-network', 'no WebSocket implementation available');

  let rate = rateForTier(tier);
  let fellBack = false;
  const onFallback = () => {
    if (fellBack) return;
    fellBack = true;
    rate = FALLBACK_RATE;
  };

  function open({ utteranceId, signal } = {}) {
    const texts = [];
    const audioListeners = [];
    const wordListeners = [];
    const errorListeners = [];
    let currentRate = rate;
    let socket = null;
    let status = 'idle'; // idle | connecting | ready | closed
    let cancelled = false;
    let finishing = false;
    let settled = false;
    let finalSeen = false;
    let delivered = 0;
    let closedSent = false;
    let attemptedFallback = false;
    let audioMs = 0;
    let keepAliveTimer = null;
    let socketError = '';
    let finishPromise = null;
    let resolveFinish = null;
    let rejectFinish = null;
    let failure = null;

    const emit = (list, value) => {
      for (const listener of [...list]) {
        try { listener(value); } catch { /* a listener must not break the stream */ }
      }
    };
    const clearKeepAlive = () => {
      if (keepAliveTimer !== null) clock.clearTimeout(keepAliveTimer);
      keepAliveTimer = null;
    };
    const send = frame => {
      if (cancelled || status !== 'ready') return false;
      try { socket.send(JSON.stringify(frame)); return true; } catch { return false; }
    };
    const settle = result => {
      if (settled) return;
      settled = true;
      status = 'closed';
      clearKeepAlive();
      signal?.removeEventListener?.('abort', cancel);
      if (resolveFinish) resolveFinish(result);
    };
    const fail = (code, message, cause) => {
      const error = voiceError(code, redact(message, key), { cause });
      if (settled) return;
      failure = error;
      settled = true;
      clearKeepAlive();
      status = 'closed';
      signal?.removeEventListener?.('abort', cancel);
      try { socket?.close(); } catch { /* already gone */ }
      emit(errorListeners, error);
      if (rejectFinish) rejectFinish(error);
    };
    const scheduleKeepAlive = () => {
      clearKeepAlive();
      keepAliveTimer = clock.setTimeout(() => {
        keepAliveTimer = null;
        if (cancelled || settled || status !== 'ready' || finishing) return;
        send({ keep_alive: true });
        scheduleKeepAlive();
      }, keepAliveMs);
    };
    const drain = () => {
      if (status !== 'ready' || cancelled) return;
      while (delivered < texts.length) {
        const input = { text: texts[delivered], voice_id: voiceId };
        if (delivered === 0) input.new_turn = true;
        send({ inputs: [input] });
        delivered += 1;
      }
      if (finishing && !closedSent) {
        send({ flush: true });
        send({ close_socket: true });
        closedSent = true;
      }
    };
    const fallback = () => {
      attemptedFallback = true;
      onFallback();
      currentRate = FALLBACK_RATE;
      audioMs = 0;
      delivered = 0;
      closedSent = false;
      connect();
    };
    function connect() {
      status = 'connecting';
      socketError = '';
      let next;
      try {
        next = new WebSocket(socketUrl(currentRate, url));
      } catch (cause) {
        fail('voice-network', 'could not open the voice socket', cause);
        return;
      }
      socket = next;
      bindSocket(next, {
        open: () => {
          if (cancelled || settled) return;
          status = 'ready';
          send({ voices: [voiceId], xi_api_key: key });
          drain();
          scheduleKeepAlive();
        },
        message: event => onMessage(event?.data ?? event),
        error: event => { socketError = String(event?.message ?? event?.error?.message ?? ''); },
        close: event => onClose(event),
      });
    }
    function onMessage(data) {
      if (cancelled || settled) return;
      const message = parseFrame(data);
      if (!message) {
        fail('voice-protocol', 'unreadable voice frame');
        return;
      }
      const problem = `${message.message ?? ''} ${message.error ?? ''}`.trim();
      if (problem && (message.error || message.code)) {
        const reason = typeof message.message === 'string' && message.message ? message.message : message.error;
        if (currentRate === PAID_RATE && !attemptedFallback && isRateRejection({ code: message.code, reason })) {
          fallback();
          return;
        }
        fail(classifyFailure({ reason: problem, message: problem, code: message.code }), problem);
        return;
      }
      if (message.alignment) emit(wordListeners, wordsFromAlignment(message.alignment, audioMs));
      if (message.audio) {
        const buffer = Buffer.from(String(message.audio), 'base64');
        if (buffer.length) {
          audioMs += pcmDurationMs(buffer.length, currentRate);
          if (!settled) emit(audioListeners, buffer);
        }
      }
      if (message.is_final === true) {
        finalSeen = true;
        settle({ ok: true });
      }
    }
    function onClose(event) {
      if (cancelled || settled) return;
      status = 'closed';
      const code = event?.code;
      const reason = String(event?.reason || socketError || '');
      if (finalSeen) { settle({ ok: true }); return; }
      if (currentRate === PAID_RATE && !attemptedFallback && isRateRejection({ code, reason })) {
        fallback();
        return;
      }
      fail(classifyFailure({ code, reason }), `voice socket closed${code ? ` (${code})` : ''}`);
    }
    function cancel() {
      if (cancelled) return;
      cancelled = true;
      clearKeepAlive();
      status = 'closed';
      signal?.removeEventListener?.('abort', cancel);
      try { socket?.close(); } catch { /* already gone */ }
      settle({ cancelled: true });
    }
    function sendText(text) {
      const value = String(text ?? '');
      if (cancelled || settled || finishing || !value) return false;
      texts.push(value);
      drain();
      return true;
    }
    function finish() {
      if (finishPromise) return finishPromise;
      finishPromise = new Promise((resolve, reject) => { resolveFinish = resolve; rejectFinish = reject; });
      if (cancelled || settled) {
        if (failure) rejectFinish(failure);
        else resolveFinish({ cancelled: true });
        return finishPromise;
      }
      finishing = true;
      drain();
      return finishPromise;
    }
    const subscribe = (list, callback) => {
      if (typeof callback !== 'function') return () => {};
      list.push(callback);
      return () => {
        const at = list.indexOf(callback);
        if (at >= 0) list.splice(at, 1);
      };
    };

    if (signal?.aborted) cancel();
    else {
      signal?.addEventListener?.('abort', cancel);
      connect();
    }

    return {
      utteranceId,
      get sampleRate() { return currentRate; },
      get closed() { return status === 'closed'; },
      sendText,
      finish,
      cancel,
      onAudio: callback => subscribe(audioListeners, callback),
      onWords: callback => subscribe(wordListeners, callback),
      onError: callback => subscribe(errorListeners, callback),
    };
  }

  return {
    get sampleRate() { return rate; },
    get tier() { return rate === PAID_RATE ? 'paid' : 'free'; },
    open,
  };
}
