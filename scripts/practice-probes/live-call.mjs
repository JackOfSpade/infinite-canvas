// LIVE practice call from source, for end-to-end checks without the packaged app or a microphone.
// Everything is real (call service, Claude interviewer sessions, ElevenLabs voice, both local models,
// recording, analysis and review) except the microphone helper, which is a stand-in that records
// silence and reports playback on a real clock. The candidate answers by chat: each file dropped in
// <outDir>/inbox (01.txt, 02.txt, ...) is sent as one typed message. A file holding only a command is
// run instead: #typing (shows the candidate typing until the next message), #hangup (leave with
// feedback), #hangup-nofeedback.
//
//   node --import ./scripts/test-stubs/register.mjs scripts/practice-probes/live-call.mjs "$PWD" <outDir> ["steering text"]
//
// It uses the first saved Interview Helper session (which must be prepared), spends Claude usage and
// ElevenLabs credits, and writes only to <outDir>: log.jsonl (states, events, timings), transcript.txt,
// review-prompt.txt, replay.json and calls/<callId>/ (call.json, analysis.json, call.m4a). It is not
// part of any test suite. Run it by hand and read log.jsonl for errors and timings.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { wavHeader } from '../../electron/practiceCall/audio/wavFormat.js';

const [repo, outDir, steering = ''] = process.argv.slice(2);
const userData = path.join(os.homedir(), 'Library/Application Support/infinite-canvas');
fs.mkdirSync(path.join(outDir, 'inbox'), { recursive: true });
const logPath = path.join(outDir, 'log.jsonl');
const talkPath = path.join(outDir, 'transcript.txt');
const t00 = performance.now();
const log = (kind, data = {}) => fs.appendFileSync(logPath, `${JSON.stringify({ t: +((performance.now() - t00) / 1000).toFixed(2), kind, ...data })}\n`);
const say = line => fs.appendFileSync(talkPath, `${line}\n`);

function createFakeHelper({ onEvent }) {
  let t0 = 0; let fd = null; let tick = null; let written = 0; let stopped = false;
  const utter = new Map();
  const at = () => Math.max(0, Math.round(performance.now() - t0));
  const emit = event => { setTimeout(() => { if (!stopped || event.type === 'recording') onEvent(event); }, 15); };
  const durationMs = u => (u.bytes / 2 / u.rate) * 1000;
  const position = u => {
    if (u.started === null) return 0;
    const played = (u.pausedAt ?? performance.now()) - u.started - u.pausedTotal;
    return Math.max(0, Math.round(Math.min(played, durationMs(u))));
  };
  const clear = u => { clearInterval(u.posTimer); clearTimeout(u.finishTimer); };
  const scheduleFinish = (id, u) => {
    clearTimeout(u.finishTimer);
    if (!u.ended || u.pausedAt !== null) return;
    const left = Math.max(0, durationMs(u) - position(u));
    u.finishTimer = setTimeout(() => {
      clear(u); utter.delete(id);
      emit({ type: 'playback', utteranceId: id, state: 'finished', positionMs: Math.round(durationMs(u)), atMs: at() });
    }, left);
  };
  return {
    start({ recordingPath }) {
      t0 = performance.now();
      fd = fs.openSync(recordingPath, 'w');
      fs.writeSync(fd, wavHeader(0, 16000));
      tick = setInterval(() => {
        const need = Math.floor(at() * 16) * 2 - written;
        if (need > 0) { fs.writeSync(fd, Buffer.alloc(need)); written += need; }
        emit({ type: 'level', rms: 0, atMs: at() });
      }, 100);
      setTimeout(() => emit({ type: 'status', state: 'ready' }), 50);
      return { ok: true };
    },
    play(id, rate) { utter.set(id, { rate, bytes: 0, started: null, ended: false, pausedAt: null, pausedTotal: 0 }); return true; },
    pushAudio(id, pcm) {
      const u = utter.get(id); if (!u) return false;
      u.bytes += pcm.length;
      if (u.started === null) {
        u.started = performance.now();
        emit({ type: 'playback', utteranceId: id, state: 'started', positionMs: 0, atMs: at() });
        u.posTimer = setInterval(() => { if (u.pausedAt === null) emit({ type: 'playback', utteranceId: id, state: 'position', positionMs: position(u), atMs: at() }); }, 50);
      }
      scheduleFinish(id, u);
      return true;
    },
    endUtterance(id) {
      const u = utter.get(id); if (!u) return false;
      u.ended = true;
      if (u.started === null) { utter.delete(id); emit({ type: 'playback', utteranceId: id, state: 'finished', positionMs: 0, atMs: at() }); return true; }
      scheduleFinish(id, u);
      return true;
    },
    cancel(id) {
      const u = utter.get(id); if (!u) return false;
      clear(u); utter.delete(id);
      emit({ type: 'playback', utteranceId: id, state: 'cancelled', positionMs: position(u), atMs: at() });
      return true;
    },
    pause(id) { const u = utter.get(id); if (!u || u.pausedAt !== null) return false; u.pausedAt = performance.now(); clearTimeout(u.finishTimer); emit({ type: 'playback', utteranceId: id, state: 'paused', positionMs: position(u), atMs: at() }); return true; },
    resume(id) { const u = utter.get(id); if (!u || u.pausedAt === null) return false; u.pausedTotal += performance.now() - u.pausedAt; u.pausedAt = null; emit({ type: 'playback', utteranceId: id, state: 'resumed', positionMs: position(u), atMs: at() }); scheduleFinish(id, u); return true; },
    mute() { return true; },
    stop() {
      if (stopped) return { status: 'stopped' };
      stopped = true;
      clearInterval(tick);
      for (const u of utter.values()) clear(u);
      const need = Math.floor(at() * 16) * 2 - written;
      if (need > 0) { fs.writeSync(fd, Buffer.alloc(need)); written += need; }
      fs.writeSync(fd, wavHeader(written, 16000), 0, 44, 0);
      fs.closeSync(fd);
      setTimeout(() => emit({ type: 'recording', state: 'closed', durationMs: Math.round(written / 32) }), 20);
      return { status: 'stopped' };
    },
    state: () => ({ status: 'ready' }),
  };
}

const { createPracticeCallService } = await import(path.join(repo, 'electron/practiceCall/callService.js'));
const { createCallStore } = await import(path.join(repo, 'electron/practiceCall/callStore.js'));
const { createInterviewClaudeTransport } = await import(path.join(repo, 'electron/ipc/interviewClaudeTransport.js'));
const reviewTransport = createInterviewClaudeTransport();
const callText = ({ prompt, schema, signal } = {}) => {
  fs.writeFileSync(path.join(outDir, 'review-prompt.txt'), String(prompt));
  return reviewTransport.callText(prompt, { signal, task: 'practice-review', claudeStage: 'qa-practice-review', responseSchema: schema });
};
// The careful planning step: its own task and Claude stage (Opus at high effort), same transport.
const planText = ({ prompt, schema, signal } = {}) => {
  fs.writeFileSync(path.join(outDir, 'plan-prompt.txt'), String(prompt));
  return reviewTransport.callText(prompt, { signal, task: 'practice-plan', claudeStage: 'practice-call-plan', responseSchema: schema });
};
const session = JSON.parse(fs.readFileSync(path.join(userData, 'interview-helper-sessions.json'), 'utf8')).sessions[0];
const d = session.data;
const store = createCallStore({ rootDir: path.join(outDir, 'calls') });
// The exact text handed to the voice (with its delivery tags) is logged, since captions and the
// transcript have the tags stripped.
const { createDialogueVoiceFactory } = await import(path.join(repo, 'electron/practiceCall/eleven/dialogueVoice.js'));
const loggedVoiceFactory = options => {
  const factory = createDialogueVoiceFactory(options);
  return {
    get sampleRate() { return factory.sampleRate; },
    get tier() { return factory.tier; },
    open(openOptions) {
      const stream = factory.open(openOptions);
      const sendText = stream.sendText;
      stream.sendText = text => { if (openOptions?.utteranceId !== 'warm-up') { log('voice-text', { text }); say(`      voice> ${text}`); } return sendText(text); };
      return stream;
    },
  };
};
// Test calls keep their own question history in the run folder, so they never change which
// questions the owner's real calls favour.
const { createQuestionHistory } = await import(path.join(repo, 'electron/practiceCall/questionHistory.js'));
const service = createPracticeCallService({
  store, userDataPath: userData, callText, planText,
  questionHistory: createQuestionHistory({ filePath: process.env.PRACTICE_HISTORY_FILE || path.join(outDir, 'question-history.json') }),
  helperFactory: options => createFakeHelper(options),
  voiceFactory: loggedVoiceFactory,
  logger: { warn: message => log('service-warn', { message }), info: message => {
    const text = String(message);
    // The setup facts: voices drawn, the plan summary and each rejected attempt, then the rooms.
    if (text.includes('rooms ')) log('rooms', { message });
    else if (/\b(voices drawn|plan attempt|plan attempts|plan \{|colleague voice)/.test(text)) { log('setup', { message }); say(`      setup> ${text}`); }
  } },
});

let last = {};
let consented = false; let answered = false; let done = false;
service.onState(state => {
  const view = { phase: state.phase, speaking: state.speaking, speakingId: state.speakingId, participants: (state.participants || []).length, interviewerLeft: state.interviewerLeft, stage: state.analysisStage, error: state.error?.code || null, typing: state.typing };
  const download = state.modelDownload?.totalBytes ? Math.floor((state.modelDownload.receivedBytes / state.modelDownload.totalBytes) * 10) : null;
  const key = JSON.stringify({ ...view, download });
  if (key === last.key) return;
  last = { key };
  log('state', { ...view, download, persona: state.persona, participants: state.participants?.map(item => `${item.id}:${item.name}:${item.status}`), speakingId: state.speakingId || undefined, errorMessage: state.error?.message, usageWarning: state.usageWarning || undefined });
  if (state.phase === 'consent' && !consented) { consented = true; service.agreeModelDownload(); }
  if (state.phase === 'ringing' && !answered) { answered = true; setTimeout(() => { log('answering'); service.answer(); }, 1500); }
  if ((state.phase === 'replay' || state.phase === 'error') && !done) { done = true; setTimeout(finish, 500); }
});
service.onEvent(event => {
  log('event', event);
  // The helper-timeline time sits beside the wall time so a control can be lined up with the recording.
  if (['screen', 'screen-stop', 'pad', 'participant-joined'].includes(event?.type)) log('timeline', { type: event.type, id: event.id ?? event.speakerId, helperAtMs: event.atMs ?? null });
  if (event?.type === 'screen') say(`[${((performance.now() - t00) / 1000).toFixed(1)}s]   === SCREEN by ${event.speakerId}: ${event.title} ===\n${event.content}\n   ===`);
  if (event?.type === 'screen-stop') say(`[${((performance.now() - t00) / 1000).toFixed(1)}s]   === screen stopped ===`);
  if (event?.type === 'overlay') say(`[${((performance.now() - t00) / 1000).toFixed(1)}s]   >>> SPOKEN OVER by ${event.speakerId}: ${event.text}`);
  if (event?.type === 'ended') say(`[${((performance.now() - t00) / 1000).toFixed(1)}s]   === call ended: ${event.reason}${event.cause ? ` (${event.cause})` : ''} ===`);
  if (event?.type === 'pad') say(`[${((performance.now() - t00) / 1000).toFixed(1)}s]   === pad ${event.open ? `opened (${event.lang})` : 'closed'} ===`);
  if (event?.kind === 'caption' && event.final) {
    // On a panel call the line is labelled with the interviewer who spoke last in it.
    const who = (service.getState().participants || []).find(item => item.id === event.speakerId);
    say(`[${((performance.now() - t00) / 1000).toFixed(1)}s] ${event.speaker === 'candidate' ? 'CANDIDATE' : `INTERVIEWER${who ? ` (${who.name})` : ''}`}: ${event.text}`);
  }
  if (event?.kind === 'speaker') say(`[${((performance.now() - t00) / 1000).toFixed(1)}s]   (now speaking: ${event.speakerId})`);
  if (event?.kind === 'participant-joined') say(`[${((performance.now() - t00) / 1000).toFixed(1)}s]   *** ${event.name} joined the call ***`);
  if (event?.kind === 'chat') say(`[${((performance.now() - t00) / 1000).toFixed(1)}s] CHAT ${event.from || 'interviewer'}: ${event.text}`);
});

async function finish() {
  try {
    const state = service.getState();
    const replay = await service.getReplay(state.callId).catch(error => ({ replayError: String(error) }));
    fs.writeFileSync(path.join(outDir, 'replay.json'), JSON.stringify(replay, null, 2));
    fs.writeFileSync(path.join(outDir, 'final-state.json'), JSON.stringify(state, null, 2));
    // The one question that is not from the prepared pool, as the planner wrote it and who asked it.
    const record = await store.readRecord(state.callId).catch(() => null);
    if (record?.unpreparedQuestion) { log('unprepared-question', record.unpreparedQuestion); say(`      unprepared question> ${record.unpreparedQuestion.text}`); }
    log('finished', { phase: state.phase });
  } finally { setTimeout(() => process.exit(0), 1500); }
}

const seen = new Set();
setInterval(async () => {
  const files = fs.readdirSync(path.join(outDir, 'inbox')).filter(name => name.endsWith('.txt')).sort();
  for (const name of files) {
    if (seen.has(name)) continue;
    seen.add(name);
    const text = fs.readFileSync(path.join(outDir, 'inbox', name), 'utf8').trim();
    try {
      if (text === '#hangup') { log('cmd', { text }); await service.hangUp({ feedback: true }); }
      else if (text === '#hangup-nofeedback') { log('cmd', { text }); await service.hangUp({ feedback: false }); }
      else if (text.startsWith('#pad\n')) { log('cmd', { text: '#pad', chars: text.length - 5 }); say(`[${((performance.now() - t00) / 1000).toFixed(1)}s] CANDIDATE (pad): ${text.slice(5).replace(/\n/g, ' / ')}`); service.updatePad(text.slice(5)); }
      else if (text === '#typing') { log('cmd', { text }); service.setTyping(true); clearInterval(globalThis.typingBeat); globalThis.typingBeat = setInterval(() => service.setTyping(true), 3000); }
      else { say(`[${((performance.now() - t00) / 1000).toFixed(1)}s] CANDIDATE (chat): ${text}`); log('send', { name, chars: text.length }); clearInterval(globalThis.typingBeat); service.setTyping(false); service.sendChat(text); }
    } catch (error) { log('inbox-error', { name, message: String(error?.message || error) }); }
  }
}, 300);

process.on('unhandledRejection', error => log('unhandledRejection', { message: String(error?.stack || error) }));
process.on('uncaughtException', error => { log('uncaughtException', { message: String(error?.stack || error) }); });
const args = {
  nodeId: session.id, briefRecordId: d.interviewHelperPreparationRecordId, snapshotId: d.interviewHelperCareerSnapshotId,
  canonicalJobUrl: d.interviewHelperJobUrl, bundleArtifactId: d.interviewHelperApplicationBundle?.artifactId,
  bundleArtifactDigest: d.interviewHelperApplicationBundle?.digest, ...(steering ? { steering } : {}),
};
log('start');
const started = await service.start(args);
log('start-returned', { phase: started.phase, error: started.error });
