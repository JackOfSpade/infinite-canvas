# Interview practice call: build contracts (Merge A)

Shared contracts for the Phase 4-5 build. Every module below is written against
these signatures. Design and measurements: docs/interview-practice-call.md.
Decided 2026-11-08: our own engine plus Smart Turn v3, a local tone model, the
ElevenLabs v4 Turbo dialogue WebSocket, two-track recording and in-app replay
with chapters. Fixtures are synthetic unless a file says otherwise. No word
lists in any decision code: counts, durations, acoustics and models only.

## Layout

```
electron/practiceCall/
  audio/      pure JS signal code (no models, no I/O except wavReader/trackWriter)
  models/     model store, Whisper features, Smart Turn, tone model, worker
  eleven/     ElevenLabs key, dialogue WebSocket voice, voice catalog, Scribe
  callService.js, callStore.js, callIpc.js   (wave 2)
  analysis/   post-call analysis and chapters (wave 3)
src/practice-call/   call window + replay renderer (?view=practice-call)
electron/practiceCallPreload.js
```

## Time base

Every time is integer ms on the practice helper's timeline (ms since mic
capture started), the same clock as helper `atMs`/`startMs`/`endMs`.
`candidate.wav` (16 kHz mono 16-bit, written by the helper) is aligned to it:
sample index = ms * 16. Muted time is silence.

## audio/ (pure)

- `wavReader.js`: `openGrowingWav(path, { fs }) -> { sampleRate, readMs(startMs, endMs) -> Float32Array (16 kHz mono, -1..1, clamps to written length), writtenMs(), close() }`. Header is 44 bytes; the file may still be growing.
- `pitch.js`: `trackPitch(samples, sampleRate, { hopMs = 10, minHz = 60, maxHz = 400 }) -> { hopMs, f0: Float32Array }` (YIN, 0 = unvoiced).
- `prosody.js`: `turnProsody({ samples, sampleRate, startMs, words: [{ text, startMs, endMs }] }) -> { speechMs, wordsPerMinute, pauses: [{ startMs, endMs }], pauseCount, longestPauseMs, pitchMedianHz, pitchRangeSt, loudnessDb, restarts }`. Pauses are silent gaps over 300 ms inside the turn. pitchRangeSt = P90-P10 of voiced f0 in semitones. loudnessDb = median frame RMS dBFS over voiced frames. restarts = immediately repeated tokens or bigrams (compared case-insensitively; this is repetition detection, not a word list).
- `baseline.js`: `createVoiceBaseline({ minSpeechMs = 20000 }) -> { add(prosody, tone?), ready(), snapshot(), relative(prosody, tone?) -> { rateRatio, pauseRatio, pitchRangeDeltaSt, loudnessDeltaDb, arousalDelta, dominanceDelta, valenceDelta } }`. Fields are null until ready or when inputs are missing.
- `toneNote.js`: `composeVoiceNote(relative, thresholds = VOICE_NOTE_THRESHOLDS) -> string | null`. Sparse: null unless at least one measure passes its threshold. Phrases relative to the user ("faster than your usual pace", "less confident than your usual", "several long pauses", "restarted a few times"). Thresholds exported as one frozen object.
- `floorBid.js`: `createFloorBidDetector({ baseline, thresholds = FLOOR_BID_THRESHOLDS }) -> { assess({ samples, sampleRate, overlapMs, wordCount }) -> { decision: 'continue' | 'pause', reason, features } }`. `continue` only for quiet AND short sounds (loudness well below the user's speech median, under ~300 ms, no sharp rising onset). Anything else pauses.
- `trackWriter.js`: interviewer track rebuilt from what the engine sent and what the helper reported: `createInterviewerTrack({ sampleRate = 24000 }) -> { addUtterance(id, pcm16le, sampleRate), started(id, atMs), paused(id, positionMs, atMs), resumed(id, atMs), ended(id, positionMs, atMs), finalize(path, { durationMs, fs }) }` writes a 24 kHz mono 16-bit WAV aligned to the helper timeline (silence elsewhere; only the played span of each utterance; resampled linearly when needed).
- `mixdown.js`: `mixTracks({ candidatePath, interviewerPath, outPath, fs }) -> { durationMs }` 24 kHz mono WAV, candidate upsampled, soft clip.
- `callMetrics.js`: post-call deterministic metrics (see Analysis).

## models/

Model files live in `<userData>/practice-models/`, downloaded on first use only
after the user agrees in the call window (sizes shown). Pinned:

| name | url | check | bytes |
|---|---|---|---|
| smartTurn | https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-gpu.onnx | sha256 ab8dc64b88713f90b571c15b714bd1330e6c883cad8763dacf65c9376dc539be | 32411198 |
| tone | https://zenodo.org/api/records/6221127/files/w2v2-L-robust-12.6bc4a7fd-1.1.0.zip/content | zip md5 76fef8c090addd7fcee60c64e9536ced; extracted model.onnx sha256 9b6e449686c0db86f5c607b8c9fa1d87468c27198a1f0a20280c4e258239763d | 609889780 (zip), 661423381 (onnx) |

- `modelStore.js`: `MODEL_SPECS`; `createModelStore({ rootDir, fetch, fs, unzip }) -> { status() -> { smartTurn, tone: 'missing' | 'ready' | 'downloading' }, ensure(name, { onProgress, signal }) -> path, pathOf(name) }`. Download to a temp file, verify, then rename; zip extracted with `/usr/bin/ditto -x -k`; only model.onnx kept.
- `whisperFeatures.js`: Smart Turn input exactly as the reference pipeline: keep the last 8 s (zero-pad at the START), zero-mean unit-variance normalise the waveform, Whisper log-mel (n_fft 400, hop 160, 80 mel, Slaney mel filters, log10 clamp 1e-10, max-8 floor, (x+4)/4), 800 frames. Parity fixture: scripts/fixtures/smart-turn-reference.json.
- `smartTurn.js`: `createSmartTurn({ modelPath, ort }) -> { predict(samples16k) -> Promise<number> /* P(turn complete) */, close() }`. ONNX input `input_features` [1,80,800], output `logits` [1,1] already a probability.
- `toneModel.js`: `createToneModel({ modelPath, ort }) -> { score(samples16k) -> Promise<{ arousal, dominance, valence }>, close() }`. ONNX input `signal` [1,N] raw float32, output `logits` [1,3] = arousal, dominance, valence (~0..1). Parity fixture: scripts/fixtures/tone-model-reference.json.
- `inferenceWorker.js`: one `worker_threads` worker owning both sessions: `createPracticeInference({ smartTurnPath, tonePath }) -> { endOfTurn(samples), tone(samples), close() }`, transferable buffers, requests queued, tone requests never delay endOfTurn (priority).

## eleven/

- `elevenKey.js`: `readElevenLabsKey({ execFile }) -> Promise<string>` runs `/usr/bin/security find-generic-password -a <user> -s infinite-canvas-elevenlabs-api-key -w`. Never log, never put in errors.
- `dialogueVoice.js`: implements the engine's `voice` interface (electron/interviewPracticeCallEngine.js) over `wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input` with `eleven_v4_turbo`, one voice, `sync_alignment=true`, PCM output at the account's rate (44.1 kHz paid, 24 kHz free; on a 403 for 44.1 retry at 24). `open({ utteranceId, signal })` returns `{ sampleRate, sendText, finish, cancel, onAudio, onWords }`; `onWords` gives `[{ word, startMs, endMs }]` cumulative from the utterance start, built from character alignment. One WebSocket per utterance (opened at speculation, warm); keep_alive under the 20 s idle limit.
- `voiceCatalog.js`: pick the persona voice first, then a name: `pickPersonaVoice({ voices, random, temperament }) -> { voiceId, name, gender, age, accent }` from account voices labelled conversational (labels gender/age/accent/use_case); regional accent -> regional name pool, American/British -> diverse pool, neutral gender -> neutral names. Name pools are data. `listConversationalVoices({ fetch, key })`.
- `scribe.js`: `transcribeVerbatim({ path, fetch, key }) -> { words: [{ text, startMs, endMs, type }] }` via POST /v1/speech-to-text, model `scribe_v2`, word timestamps, verbatim (fillers kept).

## Call service (wave 2), store and window

- Call record dir: `<userData>/practice-calls/<callId>/` (0700): `call.json` (persona, start time, thresholds, transcript with helper-timeline times, events, tone notes, timings), `candidate.wav` (helper), `interviewer.wav` (trackWriter), after the call `call.m4a` (mixdown then `/usr/bin/afconvert -f m4af -d aac`), `analysis.json`. WAVs are deleted once `call.m4a` and `analysis.json` exist. A "Delete recording" action removes the audio, keeps transcript and feedback.
- Feedback lands in the existing practice store through the registry (`arm` then `finish`), schema extended with optional `callId` and `delivery`.
- Replay audio is served by a privileged `practice-call:` protocol with range requests, readable only for known call ids.

## Analysis and chapters (wave 3)

- Deterministic (`callMetrics.js`): per answer wpm, fastest 20 s window, pauses >1 s and >2 s, response latency, answers over ~2 min, talk ratio, candidate interruptions (and whether the question had finished), pitch range vs baseline, tone measures vs baseline per answer.
- Scribe verbatim of candidate audio (fillers, restarts); Claude counts non-lexical fillers in review (no lists in code).
- One Claude review call writes the feedback (existing schema + `delivery`), chapter titles and flagged moments, each anchored to a transcript turn index; the host converts anchors to timeline ms.
- Chapters: one per interviewer question (title from the review), with markers inside (flagged moments, long pauses, interruptions, tone notes) that seek the player.

## Call window IPC (wave 2)

Canvas side (`electron/preload.js`, added by the primary): `startPracticeCall({ nodeId, briefRecordId, snapshotId, canonicalJobUrl, bundleArtifactId, bundleArtifactDigest })` → `practice-call:start` opens the call window; `openPracticeReplay({ nodeId, callId })` → `practice-call:open-replay`; `listPracticeCalls({ nodeId })` → `practice-call:list` → `[{ callId, startedAt, durationMs, persona: { name, role }, hasAudio, analysisStatus }]`.

Call window preload `electron/practiceCallPreload.js` exposes `window.practiceCallAPI` (frozen, validated args, channel prefix `practice-call-window:`):
- `getState()` → CallState; `onState(cb)` → unsubscribe; `onEvent(cb)` for transient events (caption, chat, timing).
- `agreeModelDownload()`, `answer()`, `hangUp()`, `setMuted(bool)`, `sendChat(text ≤ 2000)`, `setTyping(bool)`, `getPreparedCards()` → `[{ id, question, answer }]`.
- Replay: `getReplay()` → `{ callId, audioUrl: 'practice-call://<callId>/call.m4a' | null, durationMs, transcript, chapters, feedback, analysis: { status, error? } }`; `onReplayUpdated(cb)`; `deleteRecording()`; `close()`.

CallState: `{ phase: 'consent' | 'downloading' | 'precheck' | 'ringing' | 'connecting' | 'in-call' | 'ended' | 'analyzing' | 'replay' | 'error', callId, persona: { name, initials, role, team } | null, elapsedMs, muted, level (0..1), speaking: 'interviewer' | 'candidate' | null, typing: bool, chat: [{ from: 'interviewer' | 'candidate', text, atMs }], captions: [{ speaker, text, final }] (last 6), modelDownload: { receivedBytes, totalBytes } | null, usageWarning: string | null, error: { code, message } | null }`.

## analysis.json (wave 3)

`{ callId, status: 'ready' | 'failed', createdAt, metrics, chapters: [{ title, startMs, endMs, questionTurnIndex, markers: [{ atMs, kind: 'tone' | 'pause' | 'interruption' | 'filler' | 'moment' | 'chat', label }] }], toneTimeline: [{ atMs, arousal, dominance, valence }], fillers: { total, perMinute, byAnswer: [n] } }`. Chapter boundaries: each interviewer turn that the review marks as a new question starts a chapter; small talk before the first question is chapter "Opening"; the farewell is "Closing". Markers come from metrics (long pauses, interruptions), tone notes sent during the call, the review's flagged moments, and typed chat turns.
