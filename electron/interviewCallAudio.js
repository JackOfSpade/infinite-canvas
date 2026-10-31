import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterviewCallQuestionDetector } from './interviewCallQuestionDetector.js';

export const INTERVIEW_AUDIO_MESSAGES = Object.freeze({
  'permission-denied': 'Allow Infinite Canvas or Interview Audio Helper in System Settings → Privacy & Security → Screen & System Audio Recording, then retry Listen. Only system output is captured. You can still type.',
  'speech-assets': 'English on-device speech assets could not be prepared. Check your connection before retrying; you can still type.',
  'unsupported-locale': 'English on-device speech recognition is unavailable on this Mac. You can still type.',
  'unsupported-platform': 'Listening requires Apple Silicon and macOS 26 or later. You can still type.',
  'helper-unavailable': 'The signed audio helper is unavailable. Install an updated application build; you can still type.',
  'capture-failed': 'System audio capture stopped. Retry Listen or continue typing. Your call audio is unchanged.',
  'recognition-failed': 'On-device transcription stopped. Retry Listen or continue typing.',
  'lookup-failed': 'The detected question could not be matched. Use the transcript or type your question.',
});

export function interviewAudioHelperPath({ packaged = false, resourcesPath = process.resourcesPath, projectDir = process.cwd() } = {}) {
  // The main bundle is CommonJS, where Vite defines import.meta away.
  const root = packaged ? resourcesPath : path.join(projectDir, 'native', 'interview-audio', 'build');
  return path.join(root, packaged ? 'interview-audio' : '', 'Interview Audio Helper.app', 'Contents', 'MacOS', 'interview-audio-helper');
}

export const idleInterviewListeningState = () => ({ status: 'idle', transcript: '', question: '', errorCode: null, message: '' });

const DEBUG_LOG_LIMIT_BYTES = 5 * 1024 * 1024;
const DEBUG_LOG_MARKER_BYTES = 256;
const DEBUG_LOG_DATA_LIMIT_BYTES = DEBUG_LOG_LIMIT_BYTES - DEBUG_LOG_MARKER_BYTES;
const NO_DEBUG_LOG = Object.freeze({ write() {}, close() {} });

/** Explicit local diagnosis only. Unset/invalid paths perform no file writes.
 * Refuse links/nonprivate existing files and append within a session. A later
 * session reclaims a full log through its validated descriptor. Reserve room
 * for an explicit cap marker; diagnosis failure must never interrupt listening.
 */
export function createInterviewAudioDebugLog({ env = process.env, io = fs } = {}) {
  const filePath = env.INTERVIEW_AUDIO_DEBUG_LOG;
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || /[\p{Cc}\p{Cf}]/u.test(filePath)) return NO_DEBUG_LOG;
  let fd = null;
  const close = () => {
    if (fd === null) return;
    const opened = fd;
    fd = null;
    try { io.closeSync(opened); } catch { /* Diagnosis is best effort. */ }
  };
  const writeLine = line => {
    let offset = 0;
    while (offset < line.length) {
      const written = io.writeSync(fd, line, offset, line.length - offset);
      if (written < 1) throw new Error('Incomplete diagnostic write.');
      offset += written;
    }
  };
  try {
    if (!io.statSync(path.dirname(filePath)).isDirectory()) return NO_DEBUG_LOG;
    const flags = io.constants.O_RDWR | io.constants.O_APPEND | io.constants.O_NOFOLLOW | io.constants.O_NONBLOCK;
    let created = false;
    try {
      fd = io.openSync(filePath, flags | io.constants.O_CREAT | io.constants.O_EXCL, 0o600);
      created = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      fd = io.openSync(filePath, flags);
    }
    const stat = io.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      close();
      return NO_DEBUG_LOG;
    }
    if (created) io.fchmodSync(fd, 0o600);
    let wasCapped = stat.size >= DEBUG_LOG_DATA_LIMIT_BYTES;
    if (!wasCapped && stat.size > 0) {
      // A large rejected event may have capped the prior session before the
      // byte limit. Read its final marker from this same validated inode.
      const tail = Buffer.alloc(Math.min(DEBUG_LOG_MARKER_BYTES, stat.size));
      const length = io.readSync(fd, tail, 0, tail.length, stat.size - tail.length);
      try {
        const last = JSON.parse(tail.subarray(0, length).toString('utf8').trimEnd().split('\n').at(-1));
        wasCapped = last.type === 'log-capped' && last.reason === 'size-limit';
      } catch { /* Ordinary existing content has no cap marker. */ }
    }
    if (wasCapped) {
      // Truncate only after checking the opened inode, never through the path:
      // replacing the pathname with a link cannot redirect this operation.
      io.ftruncateSync(fd, 0);
      writeLine(Buffer.from(`${JSON.stringify({ type: 'log-reset', reason: 'previous-log-capped', previousBytes: stat.size })}\n`, 'utf8'));
    }
  } catch {
    close();
    return NO_DEBUG_LOG;
  }
  return Object.freeze({
    close,
    write(type, detail, receivedAtMs) {
      if (fd === null) return;
      try {
        const line = Buffer.from(`${JSON.stringify({ type, receivedAtMs, ...detail })}\n`, 'utf8');
        const size = io.fstatSync(fd).size;
        if (size + line.length > DEBUG_LOG_DATA_LIMIT_BYTES) {
          writeLine(Buffer.from(`${JSON.stringify({ type: 'log-capped', receivedAtMs: Number.isFinite(receivedAtMs) ? receivedAtMs : undefined,
            reason: 'size-limit', limitBytes: DEBUG_LOG_LIMIT_BYTES })}\n`, 'utf8'));
          close();
          return;
        }
        writeLine(line);
      } catch { close(); }
    },
  });
}

/** Output-only native capture. Private diagnostics require an explicit env path.
 * The executable and protocol are host-owned; no renderer-controlled arguments.
 */
export function createInterviewCallAudioService({
  helperPath = interviewAudioHelperPath(),
  spawn = nodeSpawn,
  platform = process.platform,
  arch = process.arch,
  now = () => performance.now(),
  onState = () => undefined,
  onQuestion = () => undefined,
  onPartial = () => undefined,
  detector = createInterviewCallQuestionDetector(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  let state = idleInterviewListeningState();
  let current = null;
  let generation = 0;
  let timer = null;
  let debugLog = NO_DEBUG_LOG;
  const publish = patch => { state = { ...state, ...patch }; onState({ ...state }); return { ...state }; };
  const live = (child, token) => current === child && generation === token;

  const terminate = child => {
    if (!child) return;
    // EOF is the helper's normal stop signal. SIGTERM also cancels startup
    // permission/asset awaits. A stalled native API cannot hold capture open.
    try { child.stdin?.end(); } catch { /* Process may already have exited. */ }
    try { child.kill('SIGTERM'); } catch { /* Same. */ }
    const killTimer = setTimeoutFn(() => { try { child.kill('SIGKILL'); } catch { /* Exited. */ } }, 750);
    killTimer?.unref?.();
    child.once?.('exit', () => clearTimeoutFn(killTimer));
  };
  const stop = () => {
    generation += 1;
    const child = current;
    current = null;
    if (timer !== null) clearIntervalFn(timer);
    timer = null;
    detector.reset();
    debugLog.close();
    debugLog = NO_DEBUG_LOG;
    terminate(child);
    state = idleInterviewListeningState();
    return publish({});
  };
  const fail = code => {
    stop();
    const errorCode = Object.hasOwn(INTERVIEW_AUDIO_MESSAGES, code) ? code : 'capture-failed';
    return publish({ status: 'error', errorCode, message: INTERVIEW_AUDIO_MESSAGES[errorCode] });
  };
  const start = () => {
    if (current) return { ...state };
    stop();
    if (platform !== 'darwin' || arch !== 'arm64') return fail('unsupported-platform');
    const token = generation;
    debugLog = createInterviewAudioDebugLog();
    publish({ status: 'starting', message: 'Preparing on-device speech and requesting system audio access…' });
    let child;
    try {
      child = spawn(helperPath, ['--parent-pid', String(process.pid), '--locale', 'en-US'], {
        stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
      });
    } catch { return fail('helper-unavailable'); }
    current = child;
    // Ignore native diagnostics entirely: they can contain private text or
    // paths. Drain stderr so an OS diagnostic cannot block the helper.
    child.stderr?.resume?.();
    child.stdin?.on?.('error', () => undefined);
    let pending = '';
    let receivedAt = now();
    let preparingAt = receivedAt;
    let rangeFloor = 0;
    let latestEnd = 0;
    let loggedSpeaking = null;
    child.stdout?.setEncoding?.('utf8');
    const receive = value => {
      if (!live(child, token)) return;
      const at = now();
      if (value?.type !== 'activity' || value.speaking !== loggedSpeaking) {
        debugLog.write('helper-event', { event: value }, at);
        if (value?.type === 'activity' && typeof value.speaking === 'boolean') loggedSpeaking = value.speaking;
      }
      if (!value || typeof value !== 'object') return;
      if (value.type === 'error') { fail(value.code); return; }
      if (value.type === 'status') {
        if (value.state === 'preparing') {
          preparingAt = now();
          rangeFloor = latestEnd;
          detector.reset();
          publish({ status: 'starting', transcript: '', question: '', message: latestEnd ? 'Reconnecting to system output…' : 'Preparing on-device speech and requesting system audio access…' });
        }
        if (value.state === 'listening') publish({ status: 'listening', message: '' });
        return;
      }
      if (state.status !== 'listening') return;
      if (value.type === 'activity' && typeof value.speaking === 'boolean') {
        detector.receive(value, at);
      } else if (value.type === 'transcript') {
        if (typeof value.text !== 'string' || value.text.length > 8000
          || typeof value.segmentId !== 'string' || value.segmentId.length > 100
          || typeof value.final !== 'boolean' || !Number.isFinite(value.startMs) || !Number.isFinite(value.endMs)
          || value.startMs < 0 || value.endMs < value.startMs) { fail('recognition-failed'); return; }
        if (value.startMs < rangeFloor || value.endMs <= rangeFloor) {
          debugLog.write('detector-receive', { eventType: value.type, segmentId: value.segmentId, accepted: false, reason: 'range-floor' }, at);
          return;
        }
        latestEnd = Math.max(latestEnd, value.endMs);
        const clean = { ...value, text: value.text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim() };
        const before = detector.getTranscript();
        const accepted = detector.receive(clean, at);
        debugLog.write('detector-receive', { eventType: value.type, segmentId: value.segmentId, accepted }, at);
        if (!accepted) return;
        const transcript = detector.getTranscript();
        const partial = detector.getPartial?.();
        publish({ transcript, question: '', message: '' });
        if (partial && transcript !== before) onPartial(partial);
      }
    };
    child.stdout?.on?.('data', chunk => {
      if (!live(child, token)) return;
      receivedAt = now();
      pending += chunk;
      if (pending.length > 262144) { fail('recognition-failed'); return; }
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1 && live(child, token)) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.length > 16384) { fail('recognition-failed'); return; }
        if (!line.trim()) continue;
        try { receive(JSON.parse(line)); } catch { fail('recognition-failed'); }
      }
      if (pending.length > 16384 && live(child, token)) fail('recognition-failed');
    });
    child.once?.('error', () => { if (live(child, token)) fail('helper-unavailable'); });
    child.once?.('exit', () => { if (live(child, token)) fail('capture-failed'); });
    timer = setIntervalFn(() => {
      if (!live(child, token)) return;
      const time = now();
      // Model preparation can take minutes on first use; Stop remains active.
      if (state.status === 'starting' && time - preparingAt > 300_000) { fail('speech-assets'); return; }
      if (state.status !== 'listening') return;
      if (time - receivedAt > 15_000) { fail('capture-failed'); return; }
      const endpoint = detector.poll(time);
      if (!endpoint) return;
      debugLog.write('detector-endpoint', { endpoint }, time);
      publish({ transcript: endpoint.text, question: endpoint.reason === 'too-long' ? '' : endpoint.text });
      const isCurrent = () => live(child, token) && state.status === 'listening';
      const reportSelection = decision => {
        if (isCurrent()) debugLog.write('selection', { endpointId: endpoint.id, decision }, now());
      };
      Promise.resolve().then(() => {
        if (isCurrent()) return onQuestion(endpoint, isCurrent, reportSelection);
      }).catch(() => {
        if (live(child, token)) {
          reportSelection({ stage: 'error', reason: 'lookup-failed' });
          publish({ errorCode: 'lookup-failed', message: INTERVIEW_AUDIO_MESSAGES['lookup-failed'] });
        }
      });
    }, 100);
    timer?.unref?.();
    return { ...state };
  };
  return Object.freeze({
    start, stop, getState: () => ({ ...state }),
    getQuestion: () => state.question,
    notice: message => publish({ message }),
  });
}
