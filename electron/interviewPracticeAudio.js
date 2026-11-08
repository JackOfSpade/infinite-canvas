import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';

export const PRACTICE_AUDIO_MESSAGES = Object.freeze({
  'permission-denied': 'Allow Infinite Canvas or Practice Audio Helper in System Settings → Privacy & Security → Microphone, then retry. The call can’t continue without microphone access.',
  'unsupported-locale': 'English on-device speech recognition is unavailable on this Mac, so the call can’t continue.',
  'speech-assets': 'English on-device speech assets could not be prepared. Check your connection, then retry the call.',
  'unsupported-platform': 'Practice calls require Apple Silicon and macOS 26 or later.',
  'helper-unavailable': 'The practice audio helper is unavailable. Install an updated application build to start a call.',
  'capture-failed': 'Microphone capture stopped, so the call can’t continue. Check your microphone, then retry.',
  'recognition-failed': 'On-device transcription stopped, so the call can’t continue. Retry the call.',
  'playback-failed': 'The interviewer’s voice could not be played. Check your sound output, then retry the call.',
  'recording-failed': 'The call recording could not be saved, so the call can’t continue. Retry the call.',
});

export function practiceAudioHelperPath({ packaged = false, resourcesPath = process.resourcesPath, projectDir = process.cwd() } = {}) {
  // The main bundle is CommonJS, where Vite defines import.meta away.
  const root = packaged ? resourcesPath : path.join(projectDir, 'native', 'practice-audio', 'build');
  return path.join(root, packaged ? 'practice-audio' : '', 'Practice Audio Helper.app', 'Contents', 'MacOS', 'practice-audio-helper');
}

const UTTERANCE_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const SAMPLE_RATES = Object.freeze([24000, 44100]);
const MAX_PCM_CHUNK_BYTES = 96000; // base64 expands to 128000, far under the 262144-byte stdin line cap.
const MAX_STDOUT_LINE_BYTES = 16384;
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const KILL_DELAY_MS = 750;
const STOP_LINE = `${JSON.stringify({ type: 'stop' })}\n`;

const validId = value => typeof value === 'string' && UTTERANCE_ID.test(value);
const isMs = value => Number.isSafeInteger(value) && value >= 0;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireId = value => { if (!validId(value)) throw new TypeError('utteranceId must match /^[A-Za-z0-9_-]{1,64}$/.'); };

/** Copy only the documented fields of a well-formed helper event, else null. */
function validateHelperEvent(value) {
  if (!isObject(value)) return null;
  switch (value.type) {
    case 'status':
      return value.state === 'preparing' || value.state === 'ready' ? { type: 'status', state: value.state } : null;
    case 'level':
      return typeof value.rms === 'number' && value.rms >= 0 && value.rms <= 1 && isMs(value.atMs)
        ? { type: 'level', rms: value.rms, atMs: value.atMs } : null;
    case 'vad':
      return typeof value.speaking === 'boolean' && isMs(value.atMs)
        ? { type: 'vad', speaking: value.speaking, atMs: value.atMs } : null;
    case 'transcript':
      return typeof value.text === 'string' && value.text.length >= 1 && value.text.length <= 4000
        && typeof value.segmentId === 'string' && value.segmentId.length <= 100
        && typeof value.final === 'boolean' && isMs(value.startMs) && isMs(value.endMs) && value.endMs >= value.startMs
        ? { type: 'transcript', text: value.text, segmentId: value.segmentId, final: value.final, startMs: value.startMs, endMs: value.endMs } : null;
    case 'playback':
      return validId(value.utteranceId) && ['started', 'position', 'paused', 'resumed', 'finished', 'cancelled'].includes(value.state)
        && isMs(value.positionMs) && isMs(value.atMs)
        ? { type: 'playback', utteranceId: value.utteranceId, state: value.state, positionMs: value.positionMs, atMs: value.atMs } : null;
    case 'recording':
      return value.state === 'closed' && isMs(value.durationMs)
        ? { type: 'recording', state: 'closed', durationMs: value.durationMs } : null;
    case 'error':
      return { type: 'error', code: typeof value.code === 'string' && Object.hasOwn(PRACTICE_AUDIO_MESSAGES, value.code) ? value.code : 'capture-failed' };
    default:
      return null;
  }
}

/** Main-process owner of the native Practice Audio Helper. The executable and
 * protocol are host-owned. Helper stderr is drained and ignored (it may hold
 * private text); transcript text and recording paths are never logged.
 */
export function createPracticeAudioHelper({
  helperPath = practiceAudioHelperPath(),
  spawn = nodeSpawn,
  platform = process.platform,
  arch = process.arch,
  onEvent = () => {},
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  let state = { status: 'idle', errorCode: null, message: '' };
  let current = null;
  let generation = 0;
  const live = session => current === session && generation === session.token;
  const setError = code => {
    const errorCode = Object.hasOwn(PRACTICE_AUDIO_MESSAGES, code) ? code : 'capture-failed';
    state = { status: 'error', errorCode, message: PRACTICE_AUDIO_MESSAGES[errorCode] };
    return errorCode;
  };
  const deliver = event => { try { onEvent(event); } catch { /* A consumer fault must not break parsing. */ } };
  const emit = (session, event) => { if (live(session)) deliver(event); };

  const rawWrite = (session, line) => {
    try { if (session.child.stdin?.write(line) === false) session.blocked = true; } catch { /* Process may have exited. */ }
  };
  const flush = session => {
    while (session.queue.length && !session.blocked) {
      const item = session.queue.shift();
      session.queuedBytes -= item.bytes;
      rawWrite(session, item.line);
    }
  };
  const dropQueued = (session, id) => {
    session.queue = session.queue.filter(item => !(item.utteranceId === id && item.kind !== 'control'));
    session.queuedBytes = session.queue.reduce((sum, item) => sum + item.bytes, 0);
  };
  const send = (session, kind, utteranceId, payload) => {
    const line = `${JSON.stringify(payload)}\n`;
    if (!session.blocked && !session.queue.length) { rawWrite(session, line); return; }
    const bytes = Buffer.byteLength(line);
    session.queue.push({ line, bytes, kind, utteranceId });
    session.queuedBytes += bytes;
    if (kind !== 'audio' || session.queuedBytes <= MAX_QUEUED_BYTES) return;
    // The helper cannot keep up: give up on this utterance, never on controls.
    dropQueued(session, utteranceId);
    session.dropped.add(utteranceId);
    if (session.active === utteranceId) session.active = null;
    send(session, 'control', utteranceId, { type: 'cancel', utteranceId });
    emit(session, { type: 'playback', utteranceId, state: 'cancelled', reason: 'backpressure' });
  };

  const terminate = (session, { signal = true } = {}) => {
    const { child } = session;
    // Controls queued behind backpressure still go out; audio is obsolete.
    const controls = session.queue.filter(item => item.kind === 'control');
    session.queue = [];
    session.queuedBytes = 0;
    for (const item of controls) rawWrite(session, item.line);
    rawWrite(session, STOP_LINE);
    try { child.stdin?.end?.(); } catch { /* Same. */ }
    if (!signal) return;
    try { child.kill('SIGTERM'); } catch { /* Process may already have exited. */ }
    const killTimer = setTimeoutFn(() => { try { child.kill('SIGKILL'); } catch { /* Exited. */ } }, KILL_DELAY_MS);
    killTimer?.unref?.();
    child.once?.('exit', () => clearTimeoutFn(killTimer));
  };
  let stopping = null;
  const fail = (session, code, { signal = true } = {}) => {
    if (!live(session)) return;
    generation += 1;
    current = null;
    if (stopping === session) stopping = null;
    terminate(session, { signal });
    const errorCode = setError(code);
    deliver({ type: 'error', code: errorCode });
  };

  const receive = (session, raw) => {
    const fenced = !live(session);
    // R6: the stopping session's final recording-closed line is still its own.
    if (fenced && stopping !== session) return;
    let value;
    try { value = JSON.parse(raw.toString('utf8')); } catch { return; }
    const event = validateHelperEvent(value);
    if (!event) return;
    if (fenced) {
      if (event.type === 'recording') deliver(event);
      return;
    }
    if (event.type === 'error') { fail(session, event.code); return; }
    if (event.type === 'status') state = { status: event.state === 'ready' ? 'ready' : 'starting', errorCode: null, message: '' };
    deliver(event);
  };
  const attachStdout = session => {
    let pending = [];
    let pendingBytes = 0;
    let discarding = false;
    session.child.stdout?.on?.('data', chunk => {
      let rest = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      while (rest.length && (live(session) || stopping === session)) {
        const newline = rest.indexOf(10);
        if (newline === -1) {
          if (!discarding) {
            pendingBytes += rest.length;
            if (pendingBytes > MAX_STDOUT_LINE_BYTES) { discarding = true; pending = []; pendingBytes = 0; } else pending.push(rest);
          }
          return;
        }
        const head = rest.subarray(0, newline);
        rest = rest.subarray(newline + 1);
        if (discarding) { discarding = false; continue; }
        const total = pendingBytes + head.length;
        const line = pending.length ? Buffer.concat([...pending, head]) : head;
        pending = [];
        pendingBytes = 0;
        if (total > MAX_STDOUT_LINE_BYTES || !total) continue;
        receive(session, line);
      }
    });
  };

  const start = ({ recordingPath } = {}) => {
    if (current) return { ok: false, code: 'already-running' };
    if (platform !== 'darwin' || arch !== 'arm64') { setError('unsupported-platform'); return { ok: false, code: 'unsupported-platform' }; }
    if (typeof recordingPath !== 'string' || !path.isAbsolute(recordingPath) || !recordingPath.endsWith('.wav')
      || /[\p{Cc}]/u.test(recordingPath)) { setError('recording-failed'); return { ok: false, code: 'recording-failed' }; }
    generation += 1;
    // A new session fences everything the previous one still had in flight.
    stopping = null;
    const session = { token: generation, child: null, queue: [], queuedBytes: 0, blocked: false, active: null, dropped: new Set() };
    let child;
    try {
      child = spawn(helperPath, ['--parent-pid', String(process.pid), '--locale', 'en-US', '--recording', recordingPath], {
        stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
      });
    } catch { setError('helper-unavailable'); return { ok: false, code: 'helper-unavailable' }; }
    if (!child) { setError('helper-unavailable'); return { ok: false, code: 'helper-unavailable' }; }
    session.child = child;
    current = session;
    state = { status: 'starting', errorCode: null, message: '' };
    // Ignore native diagnostics entirely: they can contain private text or
    // paths. Drain stderr so an OS diagnostic cannot block the helper.
    child.stderr?.resume?.();
    child.stderr?.on?.('error', () => undefined);
    child.stdin?.on?.('error', () => undefined);
    child.stdin?.on?.('drain', () => {
      if (!live(session)) return;
      session.blocked = false;
      flush(session);
    });
    attachStdout(session);
    child.once?.('error', () => fail(session, 'helper-unavailable'));
    child.once?.('exit', () => fail(session, 'capture-failed', { signal: false }));
    return { ok: true };
  };

  const stop = () => {
    generation += 1;
    const session = current;
    if (!session) return { ...state };
    current = null;
    // R6: keep the stopped session's own recording-closed line readable.
    stopping = session;
    terminate(session);
    state = { status: 'stopped', errorCode: null, message: '' };
    return { ...state };
  };

  const play = (utteranceId, sampleRate) => {
    requireId(utteranceId);
    if (!SAMPLE_RATES.includes(sampleRate)) throw new TypeError('sampleRate must be 24000 or 44100.');
    const session = current;
    if (!session) return false;
    // A new utterance cancels the active one in the helper; its queued audio is obsolete.
    if (session.active) dropQueued(session, session.active);
    session.active = utteranceId;
    session.dropped.delete(utteranceId);
    send(session, 'control', utteranceId, { type: 'play', utteranceId, sampleRate });
    return true;
  };
  const pushAudio = (utteranceId, pcm) => {
    requireId(utteranceId);
    if (!Buffer.isBuffer(pcm) || pcm.length % 2 !== 0) throw new TypeError('pcm must be a Buffer of 16-bit samples with an even length.');
    const session = current;
    if (!session || session.dropped.has(utteranceId)) return false;
    for (let offset = 0; offset < pcm.length; offset += MAX_PCM_CHUNK_BYTES) {
      if (!live(session) || session.dropped.has(utteranceId)) return false;
      const chunk = pcm.subarray(offset, Math.min(offset + MAX_PCM_CHUNK_BYTES, pcm.length));
      send(session, 'audio', utteranceId, { type: 'audio', utteranceId, pcm: chunk.toString('base64') });
    }
    return true;
  };
  const endUtterance = utteranceId => {
    requireId(utteranceId);
    const session = current;
    if (!session || session.dropped.has(utteranceId)) return false;
    send(session, 'end', utteranceId, { type: 'end', utteranceId });
    return true;
  };
  const cancel = utteranceId => {
    requireId(utteranceId);
    const session = current;
    if (!session) return false;
    dropQueued(session, utteranceId);
    if (session.active === utteranceId) session.active = null;
    send(session, 'control', utteranceId, { type: 'cancel', utteranceId });
    return true;
  };
  const pause = utteranceId => {
    requireId(utteranceId);
    const session = current;
    if (!session) return false;
    // Controls are never dropped by the backpressure queue.
    send(session, 'control', utteranceId, { type: 'pause', utteranceId });
    return true;
  };
  const resume = utteranceId => {
    requireId(utteranceId);
    const session = current;
    if (!session) return false;
    send(session, 'control', utteranceId, { type: 'resume', utteranceId });
    return true;
  };
  const mute = muted => {
    if (typeof muted !== 'boolean') throw new TypeError('muted must be a boolean.');
    const session = current;
    if (!session) return false;
    send(session, 'control', null, { type: 'mute', muted });
    return true;
  };

  return Object.freeze({ start, play, pause, resume, pushAudio, endUtterance, cancel, mute, stop, state: () => ({ ...state }) });
}
