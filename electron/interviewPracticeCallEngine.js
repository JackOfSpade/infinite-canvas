/**
 * Pure, injectable conversation engine for the live practice-interview call.
 * No I/O: time, sessions, audio and voice are all injected. No word lists: decisions use counts, durations and the classifier.
 */
import { createReplyStreamParser, formatTurnMessage } from './interviewPracticeCallPrompt.js';

export const DEFAULT_CALL_THRESHOLDS = Object.freeze({
  speculateMs: 500,
  commitMs: 1200,
  interruptWords: 2,
  interruptMs: 700,
  silencePromptMs: 10000,
  classifierTimeoutMs: 2500,
  voiceGateMs: 1200,
  smartTurnHoldBelow: 0.5,
  smartTurnTimeoutMs: 300,
  holdSpeculateMs: 1500,
  holdCommitMs: 2500,
  floorBidAfterMs: 250,
  resumeDelayMs: 250,
  maxResumePauseMs: 1200,
  maxPausedMs: 2500,
  voiceNoteTimeoutMs: 150,
});

// Fallback if the helper never reports `cancelled` for a stopped utterance.
const CANCEL_WAIT_MS = 500;
const OFFSET_WINDOW_MS = 2000;
const START_WATCH_MS = 3000;
const FINISH_SLACK_MS = 3000;
const OVERLAP_LOOKBACK_MS = 250;
const OVERLAP_WORD_WAIT_MS = 600;

const tokens = value => String(value ?? '').split(/\s+/).filter(Boolean);
// v4 audio tags such as [laughs] or [sighs] are spoken by the voice but never shown in captions or heard text.
const AUDIO_TAG = /\[[a-z][a-z -]{0,30}\]/g;
const stripAudioTags = value => String(value ?? '').replace(AUDIO_TAG, ' ').replace(/\s+/g, ' ').trim();
const isCancel = error => error?.name === 'AbortError' || error?.code === 'CANCELLED';
const attempt = fn => { try { return fn(); } catch { return undefined; } };

function parseVerdict(value) {
  const first = tokens(value)[0] || '';
  return first.toLowerCase().replace(/[^a-z]/g, '') === 'interruption' ? 'interruption' : 'acknowledgement';
}

/** Words of `reply` whose end time is at or before the playback position. */
function heardFor(reply, positionMs) {
  return reply.words.filter(word => word.endMs <= positionMs).map(word => word.word).join(' ');
}

/** The sentence being spoken at a playback position, judged from word counts. */
function sentenceAt(reply, positionMs) {
  if (!reply.parts.length) return '';
  const index = reply.words.findIndex(word => word.endMs > positionMs);
  if (index < 0) return reply.parts[reply.parts.length - 1];
  let seen = 0;
  for (const part of reply.parts) {
    seen += tokens(part).length;
    if (index < seen) return part;
  }
  return reply.parts[reply.parts.length - 1];
}

export function createPracticeCallEngine({
  clock, sessions, restartSession, audio, voice, ear = null,
  thresholds = DEFAULT_CALL_THRESHOLDS, onEvent = () => {}, newId,
}) {
  const th = { ...DEFAULT_CALL_THRESHOLDS, ...thresholds };
  const live = { opener: sessions.opener, main: sessions.main, classifier: sessions.classifier };
  const transcript = [];
  const segments = new Map();
  const handles = new Set();
  const named = { spec: null, commit: null, silence: null };
  const classifierControllers = new Set();
  let phase = 'connecting';
  let startedAt = null;
  let offset = null; // clock ms minus helper ms (max seen in the first OFFSET_WINDOW_MS of events, then frozen)
  let offsetSince = null;
  let turnStartMs = -Infinity;
  let pendingTyped = []; // typed texts not yet committed
  let cutOffNote = null; // prefix for the next main message after a partial main failure
  let mainRestart = null;
  let overlapWait = null;
  let speaking = false;
  let candidateSpoke = false;
  let lastVadEndMs = null;
  let typingNow = false;
  let notSpoken = false;
  let pendingAcks = [];
  let pendingInterruption = null;
  let current = null; // reply being generated, committed or played
  let cancelling = null; // reply stopped, waiting for the helper's cancelled event
  let overlap = null;
  let audioHint = false; // Smart Turn said the candidate sounds unfinished: opener-only [audio: ...] hint
  let generation = 0;

  const now = () => clock.now();
  const elapsed = () => (startedAt === null ? 0 : now() - startedAt);
  const toClock = ms => (offset === null || ms === null || ms === undefined ? null : ms + offset);
  // Only vad, level and playback events latch the offset: delivery delay only adds, so keep the max, then freeze.
  const noteHelperTime = atMs => {
    if (!Number.isFinite(atMs)) return;
    const candidate = now() - atMs;
    if (offset === null) { offset = candidate; offsetSince = now(); return; }
    if (now() - offsetSince <= OFFSET_WINDOW_MS && candidate > offset) offset = candidate;
  };
  const emit = event => { attempt(() => onEvent(event)); };

  function setPhase(next) {
    if (phase === next || phase === 'ended') return;
    phase = next;
    emit({ type: 'phase', phase });
  }

  function schedule(ms, fn) {
    const handle = clock.setTimeout(() => { handles.delete(handle); if (phase !== 'ended') fn(); }, Math.max(0, ms));
    handles.add(handle);
    return handle;
  }
  function unschedule(handle) {
    if (handle !== null && handle !== undefined && handles.delete(handle)) clock.clearTimeout(handle);
  }
  function arm(name, ms, fn) {
    unschedule(named[name]);
    named[name] = schedule(ms, () => { named[name] = null; fn(); });
  }
  function disarm(name) { unschedule(named[name]); named[name] = null; }

  const addEntry = entry => { transcript.push(entry); return entry; };
  // Helper-timeline ms for transcript entries: helper ms = clock ms - offset, else the elapsed call time.
  const helperTimelineMs = () => Math.round(offset === null ? elapsed() : now() - offset);
  const timedEntry = (entry, atMs) => addEntry({ ...entry, startMs: atMs, endMs: atMs });
  const lineOf = entry => {
    if (entry.speaker === 'interviewer') return `Interviewer: '${entry.text}'`;
    return `${entry.channel === 'chat' ? 'Candidate (typed in chat)' : 'Candidate'}: '${entry.text}'`;
  };
  const transcriptText = () => transcript.map(lineOf).join('\n');

  function candidateText(fromMs = turnStartMs) {
    return [...segments.values()].filter(item => item.startMs >= fromMs)
      .sort((a, b) => a.startMs - b.startMs).map(item => item.text.trim()).filter(Boolean).join(' ');
  }
  // The helper's VAD onset can trail the recogniser's start, so look back a little.
  const overlapText = record => candidateText(record.startMs - OVERLAP_LOOKBACK_MS);
  const lastSpoken = () => {
    for (let index = transcript.length - 1; index >= 0; index -= 1) {
      const entry = transcript[index];
      if (entry.speaker === 'interviewer' && entry.channel !== 'chat' && entry.text) return stripAudioTags(entry.text);
    }
    return undefined;
  };

  // ---- replies -------------------------------------------------------------
  function abortReply(reply) {
    unschedule(reply.cancelTimer);
    reply.cancelTimer = null;
    unschedule(reply.startTimer);
    reply.startTimer = null;
    unschedule(reply.finishTimer);
    reply.finishTimer = null;
    unschedule(reply.gateTimer);
    reply.gateTimer = null;
    reply.voiceQueue = [];
    reply.buffered = [];
    attempt(() => reply.ctl.opener.abort());
    attempt(() => reply.ctl.main.abort());
    attempt(() => reply.ctl.voice.abort());
    attempt(() => reply.stream?.cancel());
  }

  function emitDiscarded(reply, reason) {
    emit({ type: 'discarded', voiceCharsSent: reply.voiceCharsSent, reason });
  }

  function discardPending(markNotSpoken, reason = 'resumed') {
    const reply = current;
    current = null;
    if (reply) { abortReply(reply); emitDiscarded(reply, reason); }
    if (markNotSpoken) notSpoken = true;
    setPhase('listening');
  }

  function discardListen(reply) {
    if (current !== reply) return;
    current = null;
    abortReply(reply);
    emitDiscarded(reply, 'listen');
    disarm('commit');
    setPhase('listening');
    armSilence();
  }

  function fail(reason) { end(reason); }

  async function restart(kind) {
    emit({ type: 'session-restart', kind });
    try {
      const next = await restartSession(kind, { transcriptText: transcriptText() });
      if (phase === 'ended') { attempt(() => next?.close?.()); return false; }
      live[kind] = next; // always adopt: only the resend is fenced by the caller
      return true;
    } catch {
      return false;
    }
  }

  function createReply({ immediate, greeting, typed, candidates, lastWordAt, respeculated, specTokens }) {
    generation += 1;
    return {
      id: generation, utteranceId: newId(), immediate, greeting, typed, candidates, respeculated, specTokens,
      mainSentences: [], truncated: false, positionAt: null, startTimer: null, finishTimer: null, audioBytes: 0,
      commitDue: immediate, committed: false, done: false, cancelling: false, silent: false, gotAudio: false,
      buffered: [], words: [], parts: [], chats: [], deliveredChats: 0, endCall: false,
      voiceDone: false, finishCalled: false, endSent: false,
      gateOpen: immediate, gateTimer: null, voiceQueue: [], voiceCharsSent: 0, finishDeferred: false,
      mainDone: false, mainListen: false, mainForwarded: 0,
      openerSettled: greeting, openerSkipped: false,
      ctl: { opener: new AbortController(), main: new AbortController(), voice: new AbortController() },
      stream: null, sampleRate: null, entry: null, heardText: undefined,
      positionMs: 0, playbackStarted: false, cancelTimer: null, cancelWait: null, afterCancel: null,
      used: { acks: 0, interruption: null, notSpoken: false },
      spec: { at: now(), lastWordAt, openerFirstDeltaMs: null, mainFirstSentenceMs: null, firstAudioAt: null },
    };
  }

  function beginTurn({
    greeting = false, typed = false, candidates = [], text = '', channel, silenceMs = null, immediate = false,
    lastWordAt = null, respeculated = 0, specTokens = null, pausedAck = null,
  }) {
    disarm('spec');
    disarm('silence');
    if (immediate) disarm('commit');
    if (current) { const old = current; current = null; abortReply(old); } // never leave an orphan reply
    const reply = createReply({ immediate, greeting, typed, candidates, lastWordAt, respeculated, specTokens });
    current = reply;
    setPhase('speculating');
    reply.used = { acks: pendingAcks.length, interruption: pendingInterruption, notSpoken, cutOff: cutOffNote };
    const prefix = cutOffNote ?? '';
    reply.mainPrefix = prefix;
    const heldTurn = audioHint && !greeting; // Smart Turn hold: the voice gate is re-armed with the held schedule below
    const hint = heldTurn ? '[audio: sounds unfinished]' : null;
    audioHint = false;
    reply.heldTurn = heldTurn;
    if (greeting) reply.messages = { main: `${prefix}[elapsed 00:00] [call connected]` };
    else {
      const base = {
        elapsedMs: elapsed(), candidateText: text, channel, silenceMs, acknowledgements: pendingAcks.slice(),
        interruption: pendingInterruption ? { heardText: pendingInterruption.reply.heardText ?? '' } : null,
        notSpoken, typing: typingNow,
      };
      reply.turnBase = base;
      reply.messages = {
        opener: formatTurnMessage({ ...base, lastSpoken: lastSpoken(), audioHint: hint }),
        main: prefix + formatTurnMessage({ ...base, openerPlaying: true, pausedAck }),
      };
    }
    if (pausedAck !== null) reply.openerSettled = true;
    try {
      reply.stream = voice.open({ utteranceId: reply.utteranceId, signal: reply.ctl.voice.signal });
    } catch {
      current = null;
      abortReply(reply);
      emit({ type: 'error', code: 'voice-open-failed' });
      setPhase('listening');
      armSilence();
      return reply;
    }
    reply.sampleRate = reply.stream.sampleRate;
    reply.stream.onAudio(buffer => onVoiceAudio(reply, buffer));
    reply.stream.onWords(list => { if (current === reply && Array.isArray(list)) reply.words.push(...list); });
    if (!reply.gateOpen) {
      // Spoken turn: hold text back until the candidate has been silent for voiceGateMs (from the vad end, like commit).
      // On a Smart Turn hold the gate is re-armed at max(voiceGateMs, holdSpeculateMs) from the vad end, so a held turn
      // never reaches its held commit with the text still gated (which would commit a reply the voice never spoke).
      const gateMs = heldTurn ? Math.max(th.voiceGateMs, th.holdSpeculateMs) : th.voiceGateMs;
      const since = Math.max(0, now() - (toClock(lastVadEndMs) ?? now()));
      reply.gateTimer = schedule(gateMs - since, () => { reply.gateTimer = null; openGate(reply); });
    }
    if (reply.messages.opener !== undefined) runOpener(reply);
    if (typed || greeting || pausedAck !== null) runMain(reply);
    else requestVoiceNote(reply);
    return reply;
  }

  /** Ask the ear how the candidate sounded; a note decorates the MAIN message only. */
  function requestVoiceNote(reply) {
    if (typeof ear?.voiceNote !== 'function') { runMain(reply); return; }
    const startMs = Number.isFinite(turnStartMs) ? turnStartMs : 0;
    const endMs = Number.isFinite(lastVadEndMs) ? lastVadEndMs : startMs;
    let settled = false;
    let timer = null;
    const settle = note => {
      if (settled) return;
      settled = true;
      unschedule(timer);
      if (current !== reply) return; // generation fence: a stale note never reaches a newer turn
      const value = typeof note === 'string' ? note.trim() : '';
      if (value && reply.turnBase) {
        reply.messages.main = reply.mainPrefix + formatTurnMessage({ ...reply.turnBase, openerPlaying: true, voiceNote: value });
      }
      runMain(reply);
    };
    timer = schedule(th.voiceNoteTimeoutMs, () => settle(null));
    Promise.resolve().then(() => ear.voiceNote({ startMs, endMs })).then(settle, () => settle(null));
  }

  function transmit(reply, text) {
    reply.voiceCharsSent += text.length;
    attempt(() => reply.stream.sendText(text));
  }

  /** The silence gate fired: flush the queued texts in order, then run a finish that was waiting on the flush. */
  function openGate(reply) {
    if (current !== reply || reply.gateOpen) return;
    reply.gateOpen = true;
    const queued = reply.voiceQueue;
    reply.voiceQueue = [];
    for (const text of queued) transmit(reply, text);
    if (reply.finishDeferred) { reply.finishDeferred = false; callFinish(reply); }
  }

  function sendVoice(reply, sentence) {
    reply.parts.push(sentence);
    if (reply.gateOpen) transmit(reply, sentence);
    else reply.voiceQueue.push(sentence);
    if (reply.entry) {
      reply.entry.text = stripAudioTags(reply.parts.join(' '));
      emit({ type: 'caption', speaker: 'interviewer', text: reply.entry.text, final: false });
    }
  }

  function addChat(reply, chat) {
    if (reply.chats.includes(chat)) return; // de-duplicated per reply by exact text
    reply.chats.push(chat);
    if (reply.committed) deliverChats(reply);
  }

  function deliverChats(reply) {
    while (reply.deliveredChats < reply.chats.length) {
      const chat = reply.chats[reply.deliveredChats];
      reply.deliveredChats += 1;
      emit({ type: 'chat', from: 'interviewer', text: chat });
      timedEntry({ speaker: 'interviewer', channel: 'chat', text: chat }, helperTimelineMs());
    }
  }

  function forwardMain(reply, sentence) {
    if (reply.spec.mainFirstSentenceMs === null) reply.spec.mainFirstSentenceMs = now() - reply.spec.at;
    if (!reply.openerSettled) {
      reply.openerSkipped = true;
      reply.openerSettled = true;
      attempt(() => reply.ctl.opener.abort());
    }
    reply.mainForwarded += 1;
    reply.mainSentences.push(sentence);
    sendVoice(reply, sentence);
  }

  async function runOpener(reply) {
    for (let tries = 0; ; tries += 1) {
      if (current !== reply || reply.openerSettled) return;
      try {
        const result = await live.opener.turn(reply.messages.opener, {
          signal: reply.ctl.opener.signal,
          onDelta: () => { if (current === reply && reply.spec.openerFirstDeltaMs === null) reply.spec.openerFirstDeltaMs = now() - reply.spec.at; },
        });
        if (current !== reply || reply.openerSettled) return;
        if (reply.spec.openerFirstDeltaMs === null) reply.spec.openerFirstDeltaMs = now() - reply.spec.at;
        const parser = createReplyStreamParser();
        const head = parser.push(String(result?.text ?? ''));
        const tail = parser.end();
        if (tail.control === 'listen' || result?.control === 'listen') return discardListen(reply);
        reply.openerSettled = true;
        const spoken = [...head.sentences, ...tail.sentences].join(' ').trim();
        if (spoken) sendVoice(reply, spoken);
        return settle(reply);
      } catch (error) {
        if (current !== reply || reply.openerSettled || isCancel(error)) return;
        if (tries >= 1) { reply.openerSettled = true; return settle(reply); }
        const restarted = await restart('opener', reply);
        if (current !== reply) return;
        if (!restarted) { reply.openerSettled = true; return settle(reply); }
      }
    }
  }

  /** Main failed after it already forwarded output: finish with what was produced, restart for the next turn. */
  function cutOffMain(reply) {
    const forwarded = reply.mainSentences.length ? reply.mainSentences.join(' ') : reply.chats.join(' ');
    cutOffNote = `[Your previous reply was cut off by a connection problem after: '${forwarded}'.] `;
    reply.truncated = true;
    reply.mainDone = true;
    reply.mainListen = false;
    reply.endCall = false;
    mainRestart = restart('main', null).then(() => { mainRestart = null; });
    settle(reply);
  }

  async function runMain(reply) {
    if (mainRestart) await mainRestart;
    for (let tries = 0; ; tries += 1) {
      if (current !== reply) return;
      const parser = createReplyStreamParser();
      let fed = false;
      const take = snapshot => {
        for (const chat of snapshot.chats) addChat(reply, chat);
        for (const sentence of snapshot.sentences) forwardMain(reply, sentence);
      };
      try {
        const result = await live.main.turn(reply.messages.main, {
          signal: reply.ctl.main.signal,
          onDelta: delta => { if (current === reply) { fed = true; take(parser.push(delta)); } },
        });
        if (current !== reply) return;
        if (!fed) take(parser.push(String(result?.text ?? '')));
        const tail = parser.end();
        take(tail);
        reply.mainDone = true;
        reply.mainListen = tail.control === 'listen' || result?.control === 'listen';
        reply.endCall = tail.endCall || result?.endCall === true;
        return settle(reply);
      } catch (error) {
        if (current !== reply || isCancel(error)) return;
        if (reply.mainForwarded > 0 || reply.chats.length > 0) return cutOffMain(reply);
        if (tries >= 1) return fail('session-error');
        const restarted = await restart('main', reply);
        if (current !== reply) return;
        if (!restarted) return fail('session-error');
      }
    }
  }

  function settle(reply) {
    if (current !== reply || !reply.mainDone || !reply.openerSettled || reply.finishCalled) return;
    reply.finishCalled = true;
    if (!reply.parts.length) {
      if (reply.mainListen) return discardListen(reply);
      attempt(() => reply.stream.cancel());
      reply.silent = true;
      reply.voiceDone = true;
      return tryCommit(reply);
    }
    if (!reply.gateOpen) { reply.finishDeferred = true; return; } // finish only after the queue was flushed
    callFinish(reply);
  }

  function callFinish(reply) {
    const done = failed => {
      if (current !== reply) return;
      if (!reply.gotAudio) return voiceNotSpoken(reply);
      if (failed) emit({ type: 'error', code: 'voice-failed' });
      reply.voiceDone = true;
      afterVoiceDone(reply);
    };
    let pending;
    try { pending = reply.stream.finish(); } catch { pending = undefined; }
    Promise.resolve(pending).then(() => done(false), () => done(true));
  }

  /** The voice produced no audio for a reply with text: it was not spoken (end-call is not honoured). */
  function voiceNotSpoken(reply) {
    if (current !== reply) return;
    current = null;
    reply.done = true;
    abortReply(reply);
    emit({ type: 'error', code: 'voice-failed' });
    notSpoken = true;
    disarm('commit');
    setPhase('listening');
    armSilence();
  }

  function afterVoiceDone(reply) {
    if (reply.committed) {
      if (!reply.endSent) sendEnd(reply);
      return;
    }
    tryCommit(reply);
  }

  function onVoiceAudio(reply, buffer) {
    if (current !== reply) return;
    reply.gotAudio = true;
    reply.audioBytes += buffer?.length ?? 0;
    if (reply.spec.firstAudioAt === null) reply.spec.firstAudioAt = now();
    if (reply.committed) audio.pushAudio(reply.utteranceId, buffer);
    else { reply.buffered.push(buffer); tryCommit(reply); }
  }

  function tryCommit(reply) {
    if (current !== reply || reply.committed || !reply.commitDue) return;
    if (reply.buffered.length || reply.silent) commit(reply);
  }

  function markTurnConsumed() {
    const helperNow = offset === null ? null : now() - offset;
    if (helperNow !== null) turnStartMs = Math.max(turnStartMs, helperNow);
  }

  /** Clock time of the latest word end among this turn's candidate segments, else the vad end. */
  function lastWordClock() {
    let max = null;
    for (const item of segments.values()) {
      if (item.startMs >= turnStartMs && Number.isFinite(item.endMs) && (max === null || item.endMs > max)) max = item.endMs;
    }
    return toClock(max) ?? toClock(lastVadEndMs);
  }

  function startSpokenTurn(immediate, respeculated) {
    const text = candidateText();
    beginTurn({
      text, candidates: [{ speaker: 'candidate', text }], lastWordAt: lastWordClock(), immediate,
      respeculated, specTokens: tokens(text).length,
    });
  }

  /** The candidate said more since the speculation: drop it and speculate again on the fresh text, committing at once. */
  function respeculate(reply) {
    current = null;
    abortReply(reply);
    emitDiscarded(reply, 'respeculated');
    notSpoken = true;
    startSpokenTurn(true, reply.respeculated + 1);
  }

  function commit(reply) {
    if (reply.specTokens !== null && tokens(candidateText()).length > reply.specTokens) return respeculate(reply);
    reply.committed = true;
    disarm('commit');
    pendingAcks = pendingAcks.slice(reply.used.acks);
    if (pendingInterruption === reply.used.interruption) pendingInterruption = null;
    if (notSpoken && reply.used.notSpoken) notSpoken = false;
    if (cutOffNote !== null && cutOffNote === reply.used.cutOff) cutOffNote = null;
    for (const entry of reply.candidates) addEntry({ ...entry });
    if (reply.typed) pendingTyped = [];
    if (reply.candidates.length) candidateSpoke = false;
    if (reply.parts.length) {
      reply.entry = addEntry({ speaker: 'interviewer', text: stripAudioTags(reply.parts.join(' ')) });
      emit({ type: 'caption', speaker: 'interviewer', text: reply.entry.text, final: false });
    }
    deliverChats(reply);
    if (reply.silent) {
      if (reply.typed || reply.candidates.length) markTurnConsumed();
      return finishReply(reply, null);
    }
    if (reply.typed) markTurnConsumed();
    setPhase('committed');
    audio.play(reply.utteranceId, reply.sampleRate);
    for (const buffer of reply.buffered) audio.pushAudio(reply.utteranceId, buffer);
    reply.buffered = [];
    reply.startTimer = schedule(START_WATCH_MS, () => playbackStalled(reply));
    if (speaking && !overlap && offset !== null) overlapStart(now() - offset); // committed over ongoing speech
    if (reply.voiceDone && !reply.endSent) sendEnd(reply);
  }

  function sendEnd(reply) {
    reply.endSent = true;
    attempt(() => audio.endUtterance(reply.utteranceId));
    armFinishWatch(reply);
  }

  /** After endUtterance, `finished` must arrive within the remaining audio plus a slack. */
  function armFinishWatch(reply) {
    unschedule(reply.finishTimer);
    reply.finishTimer = null;
    if (current !== reply || !reply.endSent || !reply.playbackStarted) return;
    const bytesMs = reply.sampleRate ? (reply.audioBytes / 2 / reply.sampleRate) * 1000 : 0;
    const wordsMs = reply.words.reduce((max, word) => Math.max(max, word.endMs), 0);
    const position = reply.positionMs + (reply.positionAt === null ? 0 : now() - reply.positionAt);
    const remaining = Math.max(0, Math.max(bytesMs, wordsMs) - position);
    reply.finishTimer = schedule(remaining + FINISH_SLACK_MS, () => playbackStalled(reply));
  }

  function playbackStalled(reply) {
    if (current !== reply) return;
    emit({ type: 'error', code: 'playback-stalled' });
    attempt(() => audio.cancel(reply.utteranceId));
    reply.endCall = false;
    finishInterrupted(reply, reply.positionMs, null);
  }

  /** The reply ended early with the heard part only and no candidate turn behind it. */
  function finishInterrupted(reply, positionMs, atMs) {
    reply.heardText = stripAudioTags(heardFor(reply, positionMs));
    if (reply.entry) {
      if (reply.heardText) Object.assign(reply.entry, { text: reply.heardText, interrupted: true, heardText: reply.heardText });
      else { removeEntry(reply.entry); reply.entry = null; }
    }
    pendingInterruption = { reply };
    emit({ type: 'interrupted', heardText: reply.heardText });
    const parts = reply.parts;
    reply.parts = reply.heardText ? [reply.heardText] : [];
    finishReply(reply, atMs);
    reply.parts = parts;
  }

  function removeEntry(entry) {
    const index = transcript.indexOf(entry);
    if (index >= 0) transcript.splice(index, 1);
  }

  /** The reply is over (played to the end, or had nothing to play). */
  function finishReply(reply, atMs) {
    if (current !== reply) return;
    current = null;
    reply.done = true;
    abortReply(reply);
    if (reply.entry) {
      reply.entry.text = stripAudioTags(reply.parts.join(' '));
      emit({ type: 'caption', speaker: 'interviewer', text: reply.entry.text, final: true });
    }
    if (atMs !== null && atMs !== undefined) {
      noteHelperTime(atMs);
      turnStartMs = overlap?.speaking ? overlap.startMs : Math.max(turnStartMs, atMs);
    }
    if (overlap) {
      if (overlap.speaking) candidateSpoke = true;
      endOverlapRecord(overlap);
      overlap = null;
    }
    if (reply.endCall) return end('interviewer');
    setPhase('listening');
    armSilence();
  }

  function emitTiming(reply, atMs) {
    const playbackStartedAt = toClock(atMs) ?? now();
    const { lastWordAt } = reply.spec;
    emit({
      type: 'timing', ...(reply.respeculated ? { respeculated: reply.respeculated } : {}),
      voiceCharsSent: reply.voiceCharsSent,
      lastWordAt, speculatedAt: reply.spec.at,
      openerFirstDeltaMs: reply.spec.openerFirstDeltaMs, mainFirstSentenceMs: reply.spec.mainFirstSentenceMs,
      firstAudioAt: reply.spec.firstAudioAt, playbackStartedAt,
      lastWordToFirstSoundMs: lastWordAt === null || lastWordAt === undefined ? null : playbackStartedAt - lastWordAt,
    });
  }

  // ---- stopping playback ---------------------------------------------------
  function stopPlayback(reply, afterCancel = null) {
    if (current !== reply) return;
    current = null;
    if (overlap) { endOverlapRecord(overlap); overlap = null; }
    cancelling = reply;
    reply.cancelling = true;
    reply.afterCancel = afterCancel;
    abortReply(reply);
    attempt(() => audio.cancel(reply.utteranceId));
    reply.heardText = stripAudioTags(heardFor(reply, reply.positionMs));
    if (reply.entry) Object.assign(reply.entry, { text: reply.heardText, interrupted: true, heardText: reply.heardText });
    pendingInterruption = { reply };
    reply.cancelWait = schedule(CANCEL_WAIT_MS, () => resolveCancel(reply, null));
    setPhase('listening');
  }

  function resolveCancel(reply, positionMs) {
    if (cancelling !== reply) return;
    cancelling = null;
    unschedule(reply.cancelWait);
    if (positionMs === Infinity) {
      // The helper finished the whole utterance before the cancel landed: it was fully heard, not interrupted.
      reply.heardText = stripAudioTags(reply.parts.join(' '));
      if (reply.entry) {
        reply.entry.text = reply.heardText;
        delete reply.entry.interrupted;
        delete reply.entry.heardText;
      }
      if (pendingInterruption?.reply === reply) pendingInterruption = null;
    } else {
      if (positionMs !== null && positionMs !== undefined) reply.heardText = stripAudioTags(heardFor(reply, positionMs));
      if (reply.entry) {
        if (reply.heardText) Object.assign(reply.entry, { text: reply.heardText, interrupted: true, heardText: reply.heardText });
        else { removeEntry(reply.entry); reply.entry = null; }
      }
      emit({ type: 'interrupted', heardText: reply.heardText });
    }
    const next = reply.afterCancel;
    reply.afterCancel = null;
    if (next) next();
  }

  function onPlayback(event) {
    const reply = [current, cancelling].find(item => item && item.utteranceId === event.utteranceId);
    if (!reply) return;
    noteHelperTime(event.atMs);
    if (event.state === 'position') {
      reply.positionMs = event.positionMs;
      reply.positionAt = now();
      armFinishWatch(reply);
      return;
    }
    if (event.state === 'paused' || event.state === 'resumed') {
      // Helper playback states: keep the position the helper reports (heard text uses it when paused).
      if (Number.isFinite(event.positionMs)) reply.positionMs = event.positionMs;
      reply.positionAt = now();
      return;
    }
    if (event.state === 'started') {
      if (reply === current && !reply.playbackStarted) {
        reply.playbackStarted = true;
        reply.positionAt = now();
        unschedule(reply.startTimer);
        reply.startTimer = null;
        armFinishWatch(reply);
        setPhase('playing');
        emitTiming(reply, event.atMs);
      }
      return;
    }
    if (reply === cancelling) {
      resolveCancel(reply, event.state === 'finished' ? Infinity : event.positionMs);
      return;
    }
    if (event.state === 'finished') return finishReply(reply, event.atMs);
    if (event.state === 'cancelled') {
      // Not requested by the engine (for example helper backpressure): trim to what was heard.
      finishInterrupted(reply, event.positionMs, event.atMs);
    }
  }

  // ---- overlap, classifier, interruption ------------------------------------
  function boundaryDelay(reply) {
    // Estimate the live position from the last position event, capped at the utterance length.
    const lastEnd = reply.words.reduce((max, item) => Math.max(max, item.endMs), 0);
    const since = reply.positionAt === null ? 0 : Math.max(0, now() - reply.positionAt);
    const position = reply.words.length ? Math.min(reply.positionMs + since, lastEnd) : reply.positionMs + since;
    const word = reply.words.find(item => item.endMs > position);
    return word ? word.endMs - position : 0;
  }

  function boundaryCancel(reply, onStop, afterCancel = null) {
    if (reply.cancelTimer !== null) return;
    const go = () => {
      reply.cancelTimer = null;
      if (current !== reply) return;
      onStop?.();
      stopPlayback(reply, afterCancel);
    };
    const delay = boundaryDelay(reply);
    if (delay <= 0) go();
    else reply.cancelTimer = schedule(delay, go);
  }

  function endOverlapRecord(record) {
    if (!record) return;
    record.active = false;
    for (const key of ['timer', 'bidTimer', 'boundaryTimer', 'maxPausedTimer', 'resumeTimer']) unschedule(record[key]);
    record.timer = null; record.bidTimer = null; record.boundaryTimer = null;
    record.maxPausedTimer = null; record.resumeTimer = null;
  }

  const earFloorBid = () => (typeof ear?.floorBid === 'function' ? ear.floorBid : null);

  function armOverlapDuration(record) {
    unschedule(record.timer);
    const startClock = toClock(record.startMs) ?? now();
    record.timer = schedule(th.interruptMs + 1 - Math.max(0, now() - startClock), () => {
      if (!record.active || record.paused) return;
      // Echo residue has duration but no words: only stop on duration once a transcript word was counted.
      if (tokens(overlapText(record)).length >= 1) immediateStop(record);
      else record.durationElapsed = true;
    });
  }

  function overlapStart(atMs) {
    if (overlapWait) { unschedule(overlapWait.timer); overlapWait = null; }
    const record = {
      startMs: atMs, endMs: null, speaking: true, reply: current, timer: null, durationElapsed: false,
      active: true, decision: earFloorBid() ? null : 'continue', paused: false, pausedAt: null,
      bidTimer: null, boundaryTimer: null, maxPausedTimer: null, resumeTimer: null,
    };
    if (earFloorBid()) record.bidTimer = schedule(th.floorBidAfterMs, () => requestFloorBid(record));
    else armOverlapDuration(record);
    overlap = record;
  }

  /** Pause-then-decide: ask the ear at floorBidAfterMs whether the candidate is bidding for the floor. */
  function requestFloorBid(record) {
    record.bidTimer = null;
    if (!record.active) return;
    const reply = record.reply;
    if (!reply || current !== reply) { endOverlapRecord(record); return; }
    if (!record.speaking && tokens(overlapText(record)).length < 1) return; // echo residue: leave it to the word wait
    const endMs = record.endMs ?? (offset === null ? record.startMs : now() - offset);
    const bid = earFloorBid();
    const args = {
      overlapStartMs: record.startMs, overlapMs: Math.max(0, endMs - record.startMs),
      wordCount: tokens(overlapText(record)).length,
    };
    Promise.resolve().then(() => bid(args)).then(
      result => onFloorBid(record, result?.decision === 'pause' ? 'pause' : 'continue'),
      () => onFloorBid(record, 'continue'),
    );
  }

  function onFloorBid(record, decision) {
    if (!record.active || record.decision !== null) return;
    const reply = record.reply;
    if (!reply || current !== reply) { endOverlapRecord(record); return; }
    record.decision = decision;
    if (decision === 'continue') {
      if (overlap === record) armOverlapDuration(record);
      else if (tokens(overlapText(record)).length) evaluateOverlap(record, reply);
      return;
    }
    pauseAtBoundary(record, reply);
  }

  function immediateStop(record) {
    const reply = current;
    if (overlap === record) overlap = null;
    endOverlapRecord(record);
    if (!reply || reply !== record.reply) return;
    turnStartMs = record.startMs;
    candidateSpoke = true;
    stopPlayback(reply);
  }

  function overlapEnd(atMs) {
    const record = overlap;
    overlap = null;
    unschedule(record.timer);
    record.speaking = false;
    record.endMs = atMs;
    record.timer = null;
    const reply = record.reply;
    if (!record.active || !reply || current !== reply) return;
    if (record.paused) {
      if (clearInterruption(record)) return stopFromOverlap(record);
      if (tokens(overlapText(record)).length >= 1) return classify(record, reply, overlapText(record));
      return; // echo residue: the maxPaused timer decides
    }
    if (record.decision === null) return; // the floor bid is still in flight: it applies the decision
    if (record.decision === 'pause') return; // the boundary pause applies the decision, then the classifier
    if (tokens(overlapText(record)).length) return evaluateOverlap(record, reply);
    // No words yet: the recogniser can trail the VAD, so wait a little before ignoring the overlap.
    record.timer = schedule(OVERLAP_WORD_WAIT_MS, () => { if (overlapWait === record) overlapWait = null; });
    overlapWait = record;
  }

  function evaluateOverlap(record, reply) {
    if (!record.active || current !== reply) return;
    const count = tokens(overlapText(record)).length;
    if (record.endMs - record.startMs > th.interruptMs || count > th.interruptWords) {
      turnStartMs = record.startMs;
      candidateSpoke = true;
      endOverlapRecord(record);
      stopPlayback(reply);
    } else if (count >= 1) {
      classify(record, reply, overlapText(record));
    }
  }

  /** A clear interruption by the counts alone: too many words, or a long enough stretch of overlap. */
  function clearInterruption(record) {
    const endMs = record.endMs ?? (offset === null ? record.startMs : now() - offset);
    return tokens(overlapText(record)).length > th.interruptWords || endMs - record.startMs > th.interruptMs;
  }

  function boundaryPosition(reply) {
    const since = reply.positionAt === null ? 0 : Math.max(0, now() - reply.positionAt);
    return reply.positionMs + since;
  }

  function pauseAtBoundary(record, reply) {
    if (record.paused || !record.active) return;
    const pause = () => {
      record.boundaryTimer = null;
      if (!record.active || current !== reply) return;
      record.paused = true;
      record.pausedAt = now();
      reply.positionMs = boundaryPosition(reply);
      reply.positionAt = now();
      unschedule(reply.finishTimer); // a paused utterance is not stalled
      reply.finishTimer = null;
      attempt(() => audio.pause?.(reply.utteranceId));
      emit({ type: 'playback', state: 'paused', utteranceId: reply.utteranceId });
      record.maxPausedTimer = schedule(th.maxPausedMs, () => onMaxPaused(record));
      if (clearInterruption(record)) return stopFromOverlap(record);
      if (!record.speaking && tokens(overlapText(record)).length >= 1) classify(record, reply, overlapText(record));
      return;
    };
    const delay = boundaryDelay(reply);
    if (delay <= 0) pause();
    else record.boundaryTimer = schedule(delay, pause);
  }

  function stopFromOverlap(record) {
    const reply = record.reply;
    if (overlap === record) overlap = null;
    endOverlapRecord(record);
    if (!reply || current !== reply) return;
    turnStartMs = record.startMs;
    candidateSpoke = true;
    stopPlayback(reply);
  }

  function onMaxPaused(record) {
    record.maxPausedTimer = null;
    if (!record.active || !record.paused) return; // no decision in time: the pause counts as an interruption
    stopFromOverlap(record);
  }

  function classify(record, reply, text) {
    const sentence = stripAudioTags(sentenceAt(reply, reply.positionMs));
    const message = `Interviewer sentence being spoken: '${sentence}'\nCandidate's words: '${text}'\n`
      + 'Reply with exactly one word: acknowledgement or interruption.';
    const controller = new AbortController();
    classifierControllers.add(controller);
    let settled = false;
    let timer = null;
    const finish = verdict => {
      if (settled) return;
      settled = true;
      unschedule(timer);
      classifierControllers.delete(controller);
      onVerdict(record, reply, verdict, text);
    };
    timer = schedule(th.classifierTimeoutMs, () => { attempt(() => controller.abort()); finish('acknowledgement'); });
    Promise.resolve().then(() => live.classifier.turn(message, { signal: controller.signal })).then(
      result => finish(parseVerdict(result?.text)),
      error => {
        const wasSettled = settled;
        finish('acknowledgement');
        if (!wasSettled && !isCancel(error) && phase !== 'ended') restart('classifier', null);
      },
    );
  }

  function storeAck(record, text) {
    pendingAcks.push(text);
    addEntry({ speaker: 'candidate', acknowledgement: true, text, ...(record.typed ? { channel: 'chat' } : {}) });
    emit({ type: 'acknowledgement', text });
  }

  /** The classifier answered for an overlap that was paused at a word boundary. */
  function pausedVerdict(record, reply, verdict, text) {
    if (!record.active) return;
    if (verdict === 'interruption') {
      endOverlapRecord(record);
      return stopPlayback(reply);
    }
    const pausedMs = record.pausedAt === null ? 0 : now() - record.pausedAt;
    if (pausedMs > th.maxResumePauseMs) return cancelAfterPause(record, reply, text);
    unschedule(record.maxPausedTimer);
    record.maxPausedTimer = null;
    storeAck(record, text);
    record.resumeTimer = schedule(th.resumeDelayMs, () => {
      record.resumeTimer = null;
      record.active = false;
      if (current !== reply) return; // fence: a stale resume never touches a newer reply
      record.paused = false;
      attempt(() => audio.resume?.(reply.utteranceId));
      emit({ type: 'playback', state: 'resumed', utteranceId: reply.utteranceId });
      reply.positionAt = now();
      armFinishWatch(reply);
    });
  }

  /** The pause ran too long to resume in place: drop the rest and tell the main model where it stopped. */
  function cancelAfterPause(record, reply, text) {
    endOverlapRecord(record);
    stopPlayback(reply, () => beginPausedAckTurn(text));
  }

  function beginPausedAckTurn(text) {
    if (phase === 'ended') return;
    if (pendingInterruption?.reply) pendingInterruption = null; // the paused message already explains the stop
    beginTurn({ immediate: true, candidates: [], text: '', pausedAck: text });
  }

  function onVerdict(record, reply, verdict, text) {
    if (phase === 'ended') return;
    if (record.paused && current === reply && reply.committed) return pausedVerdict(record, reply, verdict, text);
    const playing = current === reply && reply.committed;
    const finished = reply.done && !current && phase === 'listening';
    if (!playing && !finished) return;
    if (verdict !== 'interruption') return storeAck(record, text);
    if (record.typed) {
      if (playing) boundaryCancel(reply, null, () => beginTyped(text));
      else beginTyped(text);
      return;
    }
    if (playing) {
      boundaryCancel(reply, () => { turnStartMs = record.startMs; candidateSpoke = true; }, () => {
        if (!speaking && phase === 'listening' && !current) scheduleTurnEnd(record.endMs);
      });
      return;
    }
    // The reply already finished: this is an ordinary candidate turn.
    candidateSpoke = true;
    turnStartMs = Math.min(turnStartMs, record.startMs);
    if (!speaking) scheduleTurnEnd(record.endMs);
  }

  // ---- candidate turns ------------------------------------------------------
  function scheduleTurnEnd(atMs) {
    noteHelperTime(atMs);
    lastVadEndMs = atMs;
    disarm('silence');
    const since = Math.max(0, now() - (toClock(atMs) ?? now()));
    arm('spec', th.speculateMs - since, onSpeculate);
    arm('commit', th.commitMs - since, onCommitDue);
    requestEndOfTurn(atMs);
  }

  /**
   * Smart Turn: ask the ear, right away, whether the audio that just ended sounds like a finished turn.
   * A held end pushes both timers out (still measured from the vad end) and flags the opener as unfinished audio.
   */
  function requestEndOfTurn(atMs) {
    if (typeof ear?.endOfTurn !== 'function') return;
    let settled = false;
    let timer = null;
    const settle = probability => {
      if (settled) return;
      settled = true;
      unschedule(timer);
      const value = typeof probability === 'number' && Number.isFinite(probability) ? probability : null;
      // Fenced against a stale answer: the candidate resumed, a newer vad end arrived, or the fast path already began.
      const stale = speaking || lastVadEndMs !== atMs || named.spec === null || current !== null;
      const held = value !== null && value < th.smartTurnHoldBelow && !stale;
      emit({ type: 'turn-model', probability: value, held });
      if (!held) return;
      audioHint = true;
      const since = Math.max(0, now() - (toClock(atMs) ?? now()));
      arm('spec', th.holdSpeculateMs - since, onSpeculate);
      arm('commit', th.holdCommitMs - since, onCommitDue);
    };
    timer = schedule(th.smartTurnTimeoutMs, () => settle(null));
    Promise.resolve().then(() => ear.endOfTurn(atMs)).then(settle, () => settle(null));
  }

  function beginSpoken() {
    if (!candidateText()) { armSilence(); return false; }
    startSpokenTurn(false, 0);
    return true;
  }

  function onSpeculate() {
    if (phase === 'listening' && !current) beginSpoken();
  }

  function onCommitDue() {
    if (phase === 'listening' && !current && !beginSpoken()) return;
    if (current && !current.committed) { current.commitDue = true; tryCommit(current); }
  }

  /** Start one typed turn from every typed text not yet committed (plus `text`, if given), in order. */
  function beginTyped(text) {
    if (text !== undefined) pendingTyped.push(text);
    if (!pendingTyped.length) return;
    disarm('spec');
    disarm('commit');
    const texts = pendingTyped.slice();
    const atMs = helperTimelineMs();
    beginTurn({
      text: texts.join('\n'), channel: 'chat', typed: true, immediate: true,
      candidates: texts.map(item => ({ speaker: 'candidate', channel: 'chat', text: item, startMs: atMs, endMs: atMs })),
    });
  }

  function armSilence() {
    disarm('silence');
    if (phase !== 'listening' || typingNow || speaking || current || named.spec || named.commit) return;
    arm('silence', th.silencePromptMs, () => {
      if (phase !== 'listening' || typingNow || speaking || current) return;
      beginTurn({ silenceMs: th.silencePromptMs, immediate: true });
    });
  }

  // ---- helper events --------------------------------------------------------
  function onVad(event) {
    noteHelperTime(event.atMs);
    if (event.speaking) {
      speaking = true;
      audioHint = false; // the candidate resumed: no stale Smart Turn hint
      disarm('silence');
      if (current && current.committed) {
        if (!overlap) overlapStart(event.atMs);
        return;
      }
      if (current && !current.typed) {
        disarm('spec');
        disarm('commit');
        candidateSpoke = true;
        discardPending(true);
        return;
      }
      if (!current) {
        disarm('spec');
        disarm('commit');
        candidateSpoke = true;
      }
      return;
    }
    speaking = false;
    if (overlap) overlapEnd(event.atMs);
    if (phase === 'listening' && !current && candidateSpoke) scheduleTurnEnd(event.atMs);
    else if (phase === 'listening') armSilence();
  }

  function onTranscript(event) {
    segments.set(event.segmentId, { text: String(event.text ?? ''), startMs: event.startMs, endMs: event.endMs, final: !!event.final });
    emit({ type: 'caption', speaker: 'candidate', text: String(event.text ?? ''), final: !!event.final });
    if (overlapWait && current === overlapWait.reply && tokens(overlapText(overlapWait)).length >= 1) {
      const record = overlapWait;
      overlapWait = null;
      unschedule(record.timer);
      evaluateOverlap(record, record.reply);
    }
    const live = overlap?.speaking ? overlap : null;
    if (live && current && current === live.reply) {
      const count = tokens(overlapText(live)).length;
      if (live.paused) {
        if (count > th.interruptWords) stopFromOverlap(live); // a clear interruption while paused cancels as today
      } else if (live.decision === 'continue' && (count > th.interruptWords || (live.durationElapsed && count >= 1))) {
        immediateStop(live);
      }
    }
  }

  function helperEvent(event) {
    if (phase === 'ended' || !event || typeof event !== 'object') return;
    if (event.type === 'error') return end('audio-error', event.code);
    if (phase === 'connecting') { noteHelperTime(event.atMs); return; }
    switch (event.type) {
      case 'vad': return onVad(event);
      case 'transcript': return onTranscript(event);
      case 'playback': return onPlayback(event);
      case 'level': noteHelperTime(event.atMs); return;
      default: return;
    }
  }

  // ---- chat and typing ------------------------------------------------------
  function typed(value) {
    const text = String(value ?? '').trim();
    if (!text || phase === 'ended' || phase === 'connecting') return;
    disarm('silence');
    typingNow = false;
    if (cancelling && !current) {
      // Queue behind the cancel: every typed text ends up in ONE typed turn, never a parallel reply.
      pendingTyped.push(text);
      const stopped = cancelling;
      const previous = stopped.afterCancel;
      stopped.afterCancel = () => { previous?.(); if (!current) beginTyped(); };
      return;
    }
    if (current && current.committed) {
      const reply = current;
      if (tokens(text).length > th.interruptWords) { pendingTyped.push(text); stopPlayback(reply, () => beginTyped()); }
      else classify({ typed: true, startMs: 0, endMs: null }, reply, text);
      return;
    }
    if (current) discardPending(true);
    beginTyped(text);
  }

  function typing(isTyping) {
    if (phase === 'ended') return;
    typingNow = !!isTyping;
    if (typingNow) disarm('silence');
    else armSilence();
  }

  // ---- end of call ----------------------------------------------------------
  function end(reason, code) {
    if (phase === 'ended') return;
    const reply = current;
    current = null;
    if (reply) {
      const played = reply.committed && !reply.done;
      abortReply(reply);
      if (played) attempt(() => audio.cancel(reply.utteranceId));
    }
    if (cancelling) { abortReply(cancelling); cancelling = null; }
    phase = 'ended';
    for (const handle of [...handles]) { handles.delete(handle); attempt(() => clock.clearTimeout(handle)); }
    for (const controller of classifierControllers) attempt(() => controller.abort());
    classifierControllers.clear();
    named.spec = null; named.commit = null; named.silence = null;
    endOverlapRecord(overlap);
    overlap = null;
    overlapWait = null;
    emit({ type: 'phase', phase });
    emit(code === undefined ? { type: 'ended', reason } : { type: 'ended', reason, code });
  }

  return {
    start() {
      if (phase !== 'connecting') return;
      startedAt = now();
      beginTurn({ greeting: true, immediate: true });
    },
    helperEvent,
    typed,
    typing,
    hangUp() { end('candidate'); },
    state: () => ({ phase, transcript: transcript.map(entry => ({ ...entry })), elapsedMs: elapsed() }),
  };
}
