# Interview practice call (Phase 1 design)

A live AI practice-interview call inside Infinite Canvas. This is a design
record: every decision and number here is settled and measured, and the
measurements are Phase 0 results on synthetic scenarios. Nothing in the call
itself is built yet.

## Status: planned vs built

| Item | Status |
|---|---|
| `electron/interviewPracticeCallPrompt.js` | Built |
| `electron/interviewPracticeTransport.js` | Built |
| `scripts/interview-practice-benchmark.mjs` | Built |
| `scripts/fixtures/interview-practice-scenarios.mjs` | Built (synthetic) |
| `scripts/practice-probes/**` | Built (Phase 0 probes) |
| Practice audio helper: `native/practice-audio/`, `scripts/build-practice-audio-helper.mjs`, `electron/interviewPracticeAudio.js` | Built, Phase 2 (compiles; not yet run against a real mic) |
| Conversation engine and simulation harness: `electron/interviewPracticeCallEngine.js`, `scripts/interview-practice-simulate.mjs`, `scripts/fixtures/interview-practice-call-scenarios.mjs` | Built, Phase 3 (simulated only; not yet run with real sessions, voice or mic) |
| Merge A additions (2026-11-08): Smart Turn v3 + tone model (`electron/practiceCall/models/`), audio analysis (`electron/practiceCall/audio/`), pause-then-decide, voice notes, helper pause/resume | Built; unit-tested and parity-checked against the official Python pipelines; not yet run in a live call |
| Voice provider (ElevenLabs v4 Turbo dialogue WebSocket, Scribe) and call window (`electron/practiceCall/`, `src/practice-call/`) | Built, Phase 4 (fakes only; not yet run live) |
| Post-call analysis, two-track recording and in-app replay with chapters | Built, Phase 5 (fakes only; not yet run live) |
| Live checklist for the user | Written, Phase 6 (section 14); not yet run |
| Interviewer interrupts long answers | Planned, Phase 7 (after acceptance) |
| Panel interviews | Planned, later |

## 1. Purpose

An in-app call window where a Claude interviewer talks with the candidate by
voice in real time. The interviewer reacts, answers clarifying questions,
handles acknowledgements and interruptions, can interrupt the candidate, and
ends the call itself. After the call it reviews performance, including
delivery: filler words, pace, pauses and interruptions.

The in-app practice call is the only practice mode.

## 2. Why not the alternatives

All settled.

- **No Claude audio API.** There is no way to send or receive speech with
  Claude directly.
- **claude.ai voice mode cannot be embedded** in the app.
- **Custom MCP tools are unreliable in voice mode.** The existing path
  already carries a text-mode fallback for this reason.
- **Google Meet** gives a personal Gmail account no transcripts, and its
  real-time media API shuts down 2027-01-15.
- **Meet bots** cost money and lose exact timing.
- **A direct Anthropic API opener is slower than the warm Claude CLI.**
  Measured, see section 10.

## 3. Architecture

```
 Renderer                      Main process                         Helper / network
 --------                      ------------                         ----------------
 Call window  <--IPC-------->  Conversation engine                  Practice audio helper (Swift)
  tiles, captions,              (pure, injectable                    - mic capture, Apple voice
  chat panel, timer             state machine)                         processing (echo cancel)
                                   |                                 - playback
                                   |-- warm CLI: opener session      - voice-activity events
                                   |-- warm CLI: main interviewer    - live on-device SpeechAnalyzer
                                   |-- warm CLI: classifier             transcript of the candidate
                                   |-- warm CLI: interjection        - 16 kHz mono local recording
                                   |     watcher (later phase)            ^
                                   |                                      | NDJSON protocol
                                   |-- ElevenLabs streaming TTS <---------+ (audio to playback)
                                   |     (WebSocket, word alignment)
                                   '-- ElevenLabs Scribe (post-call
                                         verbatim transcript)
```

- **Practice audio helper** is a new Swift app, separate from the Listen
  helper, which stays barred from mic and playback. It owns mic capture with
  Apple voice processing (echo cancellation) and playback, so the app hears
  the candidate while the interviewer speaks. It emits voice-activity events,
  a live on-device SpeechAnalyzer transcript of the candidate, and writes a
  16 kHz mono local recording. Its NDJSON protocol mirrors the Listen
  helper's discipline.
- **Main process** holds the conversation engine, a pure state machine with
  injected clock, sessions and audio, so it can be driven by the simulation
  harness. It runs two warm Claude CLI sessions per call (opener and main
  interviewer), a warm classifier session and, in a later phase, an
  interjection watcher session. ElevenLabs streaming TTS runs over WebSocket
  with word alignment. ElevenLabs Scribe produces the post-call verbatim
  transcript.
- **Renderer** is the call window.

## Practice audio helper protocol

NDJSON over stdio: one JSON object per line, UTF-8. The Node wrapper is
`electron/interviewPracticeAudio.js`. Stderr is drained and ignored.

**Launch**

| Item | Value |
|---|---|
| Executable (packaged) | `<resources>/practice-audio/Practice Audio Helper.app/Contents/MacOS/practice-audio-helper` |
| Executable (dev) | `<project>/native/practice-audio/build/Practice Audio Helper.app/Contents/MacOS/practice-audio-helper` |
| Arguments | `--parent-pid <pid> --locale en-US --recording <absolute .wav path>` |
| Spawn | stdio pipes, no shell; Apple Silicon and macOS 26 or later only |
| Recording | path is absolute, ends `.wav`, must not exist; created `O_EXCL\|O_NOFOLLOW`, mode 0600; 16 kHz mono 16-bit PCM WAV; muted time is written as silence |
| Clock | one monotonic clock, ms since mic capture start, for every `atMs`, `startMs`, `endMs` |
| Audio engine | one AVAudioEngine with Apple voice processing, so echo cancellation has the playback reference |
| Line limits | stdin lines at most 262144 bytes (wrapper sends audio chunks of at most 96000 bytes before base64); stdout lines under 16384 bytes (the wrapper drops longer lines) |
| Stop | `stop` line, stdin EOF, then SIGTERM or SIGINT; the wrapper sends SIGKILL after 750 ms |
| Watchdog | the helper exits when `--parent-pid` is gone |

**Commands (main → helper)**

| Command | Fields | Notes |
|---|---|---|
| `play` | `utteranceId`, `sampleRate` (24000 or 44100) | Starts an utterance; a new utterance cancels the active one. `utteranceId` matches `[A-Za-z0-9_-]{1,64}`. |
| `audio` | `utteranceId`, `pcm` | Base64 of 16-bit little-endian mono samples, at most 96000 bytes before base64, never split mid-sample. |
| `end` | `utteranceId` | No more audio for the utterance. |
| `cancel` | `utteranceId` | Stops the utterance now. |
| `mute` | `muted` (boolean) | Mutes the candidate's mic; the recording gets silence. |
| `stop` | none | Finish the recording and exit. |

**Events (helper → main)**

| Event | Fields | Notes |
|---|---|---|
| `status` | `state`: `preparing` or `ready` | `ready` once mic capture, playback and the analyzer run. |
| `level` | `rms` (0..1), `atMs` | Every 100 ms. |
| `vad` | `speaking` (boolean), `atMs` | On change only. Energy-based with an adaptive noise floor; at least 100 ms to start, 200 ms to end; constants tuned in Phase 3. |
| `transcript` | `text` (1..4000 chars), `segmentId`, `final`, `startMs`, `endMs` (≥ `startMs`) | On-device SpeechTranscriber, volatile and fast results. |
| `playback` | `utteranceId`, `state`: `started`, `position`, `finished` or `cancelled`, `positionMs`, `atMs` | Position about every 50 ms. |
| `recording` | `state`: `closed`, `durationMs` | After the file is finalized. |
| `error` | `code` | Fatal; the wrapper stops the helper. |

Times are integers ≥ 0. The wrapper validates every event by shape, copies only
the listed fields, and drops malformed, unknown or oversized lines. A helper
exit without a prior stop or error counts as `capture-failed`. If the helper
stops reading and more than 4 MB of lines queue, the wrapper cancels the active
utterance, drops its queued audio and reports a local `playback` event with
state `cancelled` and reason `backpressure`; control lines are never dropped.

**Error codes**

| Code | Meaning |
|---|---|
| `permission-denied` | Microphone access denied. |
| `unsupported-locale` | On-device English recognition unavailable. |
| `speech-assets` | Speech assets could not be prepared. |
| `unsupported-platform` | Not Apple Silicon with macOS 26 or later. |
| `capture-failed` | Mic capture stopped; also the wrapper's code for a crash or an unknown code. |
| `recognition-failed` | Live transcription stopped. |
| `playback-failed` | Playback failed. |
| `recording-failed` | The recording could not be created or written; the wrapper also uses it for a bad recording path. |
| `helper-unavailable` | Wrapper only: the helper could not be spawned or errored. |

**Privacy.** No transcript text or recording path is ever logged. The
recording is 0600 and created exclusively, and is deleted after successful
analysis unless "keep recording" is on.

## 4. Two-part replies (latency design)

The first sound matters most. No single configuration met the original 1.5 s
p95 gate (section 10), so a reply is made of two parts.

1. At 0.5 s of candidate silence (tuned in Phase 3, section 10a) the turn is sent speculatively to
   both sessions in parallel.
2. The **opener session** writes only a 2–8 word natural reaction
   (acknowledge or reflect back; never a question, a judgment or a fact), or
   `<listen/>` if the candidate is not done.
3. The **main session** is told a reaction is already being spoken for it
   and starts with the substance.
4. Speech is fed to ElevenLabs from the first phrase, not the full sentence.
5. Playback starts at the commit threshold, 1.2 s. Text reaches the voice
   only after the voice gate, also 1.2 s of silence, so discarded speculation
   costs no ElevenLabs characters.
6. If the candidate resumes before playback, both replies are discarded. The
   work is generation-fenced like the matcher.
7. The app keeps the authoritative transcript of what was actually spoken.

Estimated last-word-to-first-sound is about 1.7–2.0 s typical. This is an
estimate, to be measured end to end in Phase 3.

## 5. Turn-taking state machine

```
                      candidate speech
        +---------------------------------------------+
        |                                             |
        v        ~0.5 s silence                       |
   [LISTENING] ------------------> [SPECULATING] -----+  candidate resumes:
        ^                           opener + main      |  discard both replies
        |                           run in parallel    |
        |  opener says <listen/>         |             |
        +--------------------------------+             |
                                         | commit threshold (start 1.2 s)
                                         v
                                    [PLAYING] ---- overlap ----> [OVERLAP?]
                                      |  ^                         |      |
                                      |  |  acknowledgement:       |      |
                                      |  +-------- keep playing ---+      |
                                      |                                   |
                                      |     interruption: stop voice, add note
                                      |     <------------------------------+
                                      v
                       reply finished  --> [LISTENING]
                       <end-call/> after farewell --> [ENDED]
                       hang-up (any state)         --> [ENDED]
```

| State / event | Behaviour |
|---|---|
| Listening | Waits for the candidate. After 10 s of silence the interviewer is sent `[candidate silent 10s]` and reacts. |
| Speculating | At 0.5 s of silence the turn goes to the opener and main sessions at once. Either may answer `<listen/>` (the candidate is still thinking), which discards the reply. |
| Keep-listening | The opener answers `<listen/>`: nothing is spoken, the interviewer keeps waiting. A 1.5 s mid-answer pause must not cause a cut-in. |
| Commit | At the commit threshold (1.2 s) playback may begin. Resumed speech before this discards both replies, and the next message says the reply was not spoken. |
| Playing | Reply streams from ElevenLabs through the helper's playback. |
| Clear interruption | Overlap of more than 2 words or more than about 0.7 s stops the voice immediately. |
| Ambiguous overlap | Shorter overlap asks the classifier session. If it says interruption, the voice stops at the next word boundary. Otherwise it is an acknowledgement and speech continues. |
| Acknowledgement | Mid-sentence "right" or "gotcha": no stop and no reply. |
| End of call | The interviewer says a farewell, then emits `<end-call/>`; the app ends the call. |
| Hang-up | The candidate ends the call from any state. |
| Session crash | The warm session is restarted with the transcript so far and the call continues. |

No word lists in code. Acknowledgement versus interruption is decided by
duration, word count and the classifier only.

**Interruption note.** Using ElevenLabs word timestamps against the playback
position, the app works out what the candidate actually heard and tells the
interviewer:

```
[You were interrupted after saying: '<heard text>'. The rest was not heard.] Candidate: '<text>'
```

**Time and silence.** Every message carries the elapsed time. Silence is
reported as `[candidate silent 10s]`.

## 6. Chat box

New and decided. The call window has an optional chat panel for typed
messages, mixable with voice.

- **Typed turns** go to the interviewer marked as typed:
  `Candidate (typed in chat): '…'`. They carry the same elapsed time and the
  same acknowledgement and interruption notes as spoken turns.
- **"I'll type it in chat."** The interviewer answers naturally (generated,
  not canned) and waits. The app shows a typing indicator, tells the
  interviewer the candidate is typing, and pauses the 10 s silence prompt.
- **Typing while the interviewer speaks** follows the same rules as talking
  over it. More than 2 words interrupts, with the heard-text note. A shorter
  message goes to the classifier.
- **Interviewer posts.** The interviewer may post to chat with a
  `<chat>…</chat>` tag. The text is shown, not spoken. Example: a problem
  statement.
- **Feedback.** Typed turns count for content feedback but are excluded from
  delivery metrics. The review notes which answers were typed.

## 7. The interviewer interrupting the candidate

The state machine is built in Phase 3 and enabled with Phase 7.

A small watcher session checks the live transcript every 15–20 s once an
answer passes about 60 s. It may interject with a natural line: a
clarification, steering the candidate back, or time pressure. Temperament
sets frequency (tough more, warm rarely) with a per-call cap. It is not on
the latency path. Feedback counts the times the interviewer had to stop the
candidate.

## 8. Personas and voices

Pick the voice first, then a fitting name.

- **Labels.** ElevenLabs voices carry labels for gender, age, accent and use
  case (verified via the API).
- **Pool.** Conversational English voices with known gender at price
  multiplier 1.0, from the built-in voices and the shared Voice Library.
  Library voices need a paid plan via the API.
- **Names.** A distinct regional accent gets a name common in that region.
  Broad American and British accents get a name from a deliberately diverse
  pool. Neutral-gender voices are included and get gender-neutral names. Age
  can inform seniority. Name pools are data, not checks.
- **Temperament.** Warm, neutral or tough. Unless the user picks tough, the
  interviewer (Claude) chooses it to fit the voice: the main session's
  prompt describes the voice (age, accent, gender, the descriptors after the
  dash in its ElevenLabs name, its `descriptive` label and a 200-character
  blurb with the voice's own name cut out) and asks for one temperament with
  a sound-based rule (warm only for clearly warm or playful voices, neutral
  for calm or professional ones, tough for firm or deep confident ones) and
  "do not default to warm". It answers `READY <temperament>`; only the last
  line counts, since Claude sometimes explains first. The opener session
  starts after that with the same temperament, which adds one session start
  to the precheck. An unreadable choice falls back to neutral
  (`persona.temperamentFrom`: `claude`, `request` or `fallback`). A restarted
  main session gets the settled temperament. Without the rule Claude chose
  warm for all 8 account voices (2026-11-08). With it, the same choice came
  back every time over 3 runs: 3 warm, 4 neutral, 1 tough (Charlie).
- **Consistency.** One consistent voice per persona.
- **Eligibility.** A voice joins the pool only when it is conversational,
  has a gender label, is English (labels, fine-tuning and verified languages;
  premade voices carry no language label and count as English) and has a price
  multiplier of at most 1. Until 2026-11-08 a Chinese-language library voice
  ("Xin", `language: zh`) passed the conversational filter.
- **Selection.** One uniform random draw over the whole ElevenLabs shared
  library and never over the user's own account voices: 3,427 English
  conversational voices on 2026-11-08, about 70% male, so interviewers skew
  male. The voice used on the previous call is skipped while another exists
  (`lastUsed` in `<userData>/practice-voice-pool.json`). The draw is
  GET-only (`/v1/shared-voices`) and never writes to the account. Temperament
  variety comes from the voice pick, since Claude's choice is steady per
  voice. Checked live by `scripts/practice-probes/persona-e2e.mjs`
  (`--claude K` starts K real interviewer sessions and records their
  choices; `--library-draws N` chains N real draws and checks gender,
  consecutive repeats and GET-only traffic). There is no fallback: if the
  library cannot be read, or no eligible library row is found, the call ends
  with `voice-library-unavailable` before it rings and the loading screen
  shows "Could not load an interviewer voice from the ElevenLabs voice
  library. Check your internet connection and try again."
- **Library voices** are used straight from the shared library and never
  saved, removed or edited (`electron/practiceCall/eleven/voiceLibrary.js`):
  an unsaved library voice id works with the text-to-dialogue WebSocket, and
  the app sends no POST or DELETE to `/v1/voices`, so it can never hit a
  voice-slot or voice-operation limit. The first line of an unsaved voice is
  slow (~4.5 s on 2026-11-08) while every later line is ~0.2 s, the same as
  an account voice; loading time at call start does not matter to the user,
  mid-call latency does. So a library voice gets exactly one discarded
  warm-up `Hi.` while the call is loading, before it can ring: measured
  latencies stay ~0.25 s for the greeting and later lines, even after 30, 90
  and 180 s of silence. If the warm-up errors, returns no audio or does not
  finish within 15 s, the call ends with `voice-warmup-failed` before it
  rings and the loading screen shows "The interviewer voice did not respond.
  Try starting the call again."; nothing falls back to an account voice and
  no helper, track or session is created. The probe's step 10
  measures the warm-up and the greeting on a real drawn library voice and
  saves the greeting WAV. Background from 2026-11-08: saved library voices
  take no custom voice slot (a Starter account with 10 slots reported
  `voice_slots_used` 1 while holding 8 saved library voices, because slots
  count only Voice Design and cloned voices), and saving or removing one
  cost 0 of the 65 monthly voice operations (`voice_add_edit_counter`
  stayed 0; editing would cost one).
- **Audio format.** 44.1 kHz on Pro and above (same credits; ElevenLabs
  bills per character). 24 kHz on Free, Starter and Creator: ElevenLabs
  refuses `pcm_44100` below Pro (403 `subscription_required`, verified live
  on Starter 2026-11-08). Tiers it does not know ask for 44.1 kHz and fall
  back to 24 kHz automatically.
- **Listening test.** The user found the conversational voices Roger, Chris,
  Jessica and River sounded much better than the narrative voice George.

## 9. Panel interviews (later phase)

Several interviewers, each with its own voice. One warm session plays the
whole panel and tags each sentence with its speaker, so panelists hand off
naturally. The call window shows a tile per interviewer.

## 10. Phase 0 measurements

All on synthetic scenarios.

### Interviewer benchmark

9 configurations × 2 runs. First-sentence time in ms (p50 / p95). Quality is
from blind judges over 7 scenarios; the judges did not know the configs.

| Config | First sentence p50 / p95 (ms) | Blind-judge quality |
|---|---|---|
| opus / low | 1398 / 2040 | 83.1% |
| opus / medium | 1516 / 2611 | 83.1% |
| opus / high | 1612 / 2493 | 85.4% |
| sonnet / low | 1628 / 5520 (one timeout) | 76.7% |
| sonnet / medium | 2331 / 5559 | 76.2% |
| sonnet / high | 3283 / 5278 | 72.3% |
| haiku / low | 1347 / 1857 | 77.0% |
| haiku / medium | 1400 / 2704 | 72.3% |
| haiku / high | 2118 / 4255 | 73.1% |

Keep-listening was correct in every config. No single config met the
original 1.5 s p95 gate, which led to the two-part design (section 4).

### Opener

First word p50 / p95. Rule-following means a short reaction of at most 12
words with no question.

| Opener | First word p50 / p95 | Rule-following |
|---|---|---|
| Claude CLI, warm, Opus low | 0.70 / 1.17 s | 34/34 |
| Claude CLI, Haiku low | 0.93 / 1.89 s | 3/34 |
| Anthropic API, Haiku, thinking off | 0.44 / 0.82 s | 11/34 |
| Anthropic API, Sonnet, thinking off | 0.58 / 0.97–1.07 s | 23/34 |
| Anthropic API, Opus (thinking cannot be disabled; adaptive at low effort) | 0.95–0.98 / 1.92–2.29 s | 34/34 |
| DeepSeek Flash, one-shot via offload | whole opener 1.41 / 1.70 s (complete reply, not first word) | frequently ignored the length rule |

**Decision:** the opener is Opus low on the warm Claude CLI. Thinking is
adaptive at low effort, on the Ultra plan, with no API spend.

### Main reply

Opus low. Quality is within noise of Opus high, first-sentence p95 is 2.0 s,
and the reply is ready before the opener finishes speaking.

### Classifier

Acknowledgement versus interruption, 48 cases. Every config was 100%
accurate. The fastest p95 was Opus low at 1087 ms. The 0.6 s gate is
unreachable with a warm CLI (about 0.9 s floor), and the user relaxed it to
1.2 s. **Decision:** Opus low.

### Voice

| Model | Time to first audio |
|---|---|
| ElevenLabs Flash, one session | 160 / 169 ms |
| ElevenLabs Flash, another session | about 546 / 574 ms |
| Turbo | 535 / 576 ms |
| Multilingual v2 | 501 / 535 ms |
| v3 | 531 / 612 ms |

Turbo, Multilingual v2 and v3 were measured in the same session. Word alignment arrived in every trial.

User listening test: v3 was the most realistic. Flash and Multilingual v2
are indistinguishable when spliced; v3 is audibly different. So one model
speaks a whole reply. Conversational voices (labelled `conversational`)
avoid the storytelling feel of narrative voices.

**Decision:** ElevenLabs only; v3 with conversational voices. The final pick
is confirmed in Phase 4.

### Filler recall for post-call analysis

16 speakers from the AMI Meeting Corpus test split (CC BY 4.0), scored
against the human transcript.

| Engine | Fillers found | Recall | Result |
|---|---|---|---|
| Apple SpeechTranscriber, on-device | 147/341 | 43% | Fails the 80% rule (the SDK has no disfluency option) |
| ElevenLabs Scribe v2 | 311/353 | 88% | Passes; about 0.4 s per short clip; works on the ElevenLabs free tier |

**Decision:** Scribe v2 is the only speech-to-text vendor supported for the
post-call verbatim transcript. AssemblyAI and Deepgram were considered and
rejected, so one vendor holds both voice and transcription. Apple
SpeechAnalyzer stays for the live in-call transcript.

### Known prompt gap

Fix in Phase 3: at 46:00 elapsed no config properly began wrapping up. The
Phase 3 prompt now gives time-anchored wrap-up guidance from the upper target
(start about 5 minutes before it, close after it). Not yet re-measured live.

## 10a. Phase 3 threshold tuning (simulation)

The harness (`scripts/interview-practice-simulate.mjs`) drives the real engine
with a virtual clock, fake helper, fake voice and fake sessions whose
latencies are the Phase 0 measurements. Within-answer pauses are REAL: 1380
gaps from the AMI Meeting Corpus test split (CC BY 4.0), in
`scripts/fixtures/ami-within-turn-pauses.json`: median 1.61 s, 36% over 2 s,
10% over 4 s. The speech text is synthetic.

Silence alone cannot tell a thinking pause from a finished turn at these
lengths. The opener and main models decide (`<listen/>`); silence only sets
how soon they are asked. A wrong guess means the interviewer starts a reaction,
the candidate keeps talking, and playback stops after about 0.3-0.5 s, as a
real interviewer would. So a small cut-in rate is accepted for lower latency.

Sweep, 20 seeds, voice gate 1.2 s, models right about "still thinking" 90% of
the time (an assumption; not yet measured on real fragments):

| speculateMs | Answers with a cut-in | Talk-over | Last word to first sound p50 / p95 |
|---|---|---|---|
| 400 | 12.5% | ~330 ms | 1.85 / 2.20 s |
| 500 | 10.8% | ~420 ms | 1.95 / 2.27 s |
| 600 | 8.3% | ~480 ms | 2.05 / 2.41 s |
| 800 | 5.8% | ~410 ms | 2.25 / 2.60 s |

At 100% accuracy there are no cut-ins; at 80% they roughly triple. commitMs up
to 1.5 s changes nothing (generation is slower than that); 2.0 s or more only
adds delay. The voice gate adds no latency in any row.

**Decision:** speculateMs 0.5 s, commitMs 1.2 s, voiceGateMs 1.2 s,
interruptWords 2, interruptMs 0.7 s (a duration stop needs at least one
transcribed word, so echo residue never stops playback), silence prompt 10 s,
classifier timeout 2.5 s. Confirm in the Phase 6 live checklist.

## 11. Post-call analysis

**Deterministic metrics, computed in code** from the timed transcript and
the recording:

- Pace in words per minute, per answer and for the fastest 20 s window.
- Pauses longer than 1 s and longer than 2 s; response latency.
- Answer length flag at about 2 minutes; talk ratio.
- Candidate interruptions, and whether each came before the question
  finished.
- Restarts and repetitions, and um/uh, from Scribe's verbatim transcript.
- Pitch range, P90−P10 of F0, against the candidate's own baseline.

**Judged by Claude in the review.** Word fillers ("like", "you know") and
hedges, counting only non-lexical uses. No string lists in code.

**Review.** One Claude review call writes the existing feedback schema,
extended with a delivery section that cites the metrics. The aim is fewer
fillers, not zero. The result goes into the existing practice feedback
history and is shown in `InterviewPracticePanel`. Feedback is read, never
spoken.

**Privacy.** Recordings go to ElevenLabs for Scribe. After successful
analysis they are deleted: locally unless "keep recording" is on, and from
ElevenLabs if its API allows.

## 12. Phases

| Phase | Scope |
|---|---|
| 2 | Practice audio helper. |
| 3 | Conversation engine, simulation harness and threshold tuning. |
| 4 | Voice provider and call window. |
| 5 | Post-call analysis and feedback UI. |
| 6 | Live checklist for the user. |
| 7 | After acceptance: the interviewer interrupts long answers. |
| Later | Panel interviews. |

**Phase 3 simulation harness.** A scripted candidate with real timing.
Cases: "right" or "gotcha" mid-sentence (no stop, no reply); "sorry, do you
mean X?" (stops and answers); a 1.5 s mid-answer pause (no cut-in); 10 s of
silence (the interviewer reacts); hang-up; session crash (recovers);
end-call (farewell, then ends); and chat cases (typed turns, "I'll type it
in chat" with the typing indicator and paused silence prompt, typing while
the interviewer speaks, a `<chat>` post). Phase 3 tuned the thresholds (section 10a) and added the wrap-up guidance.

**Phase 4 call window.** Incoming-call screen with a ringtone and Answer
button; interviewer tile with a speaking ring; optional camera tile; mute,
hang up and timer; captions toggle, off by default; prepared-answer cards
switch, hidden by default; chat panel; call-ended screen. A generic
video-call look, with no Google Meet branding.

## 13. Rules carried forward

- Never mention the app, the tool or the feedback in character.
- Never invent company facts. Answer only from the sealed brief and deflect
  otherwise.
- Model choices use family aliases, with reasons.
- No word lists in code checks.
- Fixtures are labelled synthetic.
- The ElevenLabs API key lives in the Keychain item
  `infinite-canvas-elevenlabs-api-key` and is never logged.

## 14. Live checklist (Phase 6)

Run after building the app. Wear headphones for the first call. Timings come from the call record (`<userData>/practice-calls/<callId>/call.json`, `timings` and `transcript`).

1. **Setup.** Interview Helper → Prepare done → "Start practice call". First time: the consent screen lists the two models (32 MB, 610 MB); agree and wait for the download. Pass: the pre-call check shows a moving mic level and the incoming-call screen rings with a persona name.
2. **Answer and first reply.** Answer; the interviewer greets you. Pass: speech starts within about 3 s, sounds like one consistent voice, captions (if turned on) match.
3. **Thinking pause.** Answer a question, pause 2-3 s mid-thought, then continue. Pass: no interruption in most tries (a rare short "mm" reaction that stops is acceptable).
4. **Acknowledgement.** Say "right" or "mm-hm" quietly while it talks. Pass: it keeps talking without a hiccup and does not reply to it.
5. **Interruption.** Interrupt with "sorry, do you mean …?". Pass: it stops within about half a second, answers the clarification and does not resume its old sentence.
6. **Short interruption.** Say "no, wait" over it. Pass: it pauses, then either yields or picks back up naturally.
7. **Silence.** Say nothing for 10 s after a question. Pass: it prompts or rephrases once.
8. **Chat.** Type an answer in the chat panel. Pass: it treats it as your answer; it may post a written problem statement in chat.
9. **Off-brief question.** Ask something the brief does not cover. Pass: it deflects, never invents a company fact.
10. **End.** Let it wrap up (or hang up). Pass: farewell, then the call ends; the replay screen appears after analysis with chapters per question, markers (long pauses, interruptions, tone notes, chat), the transcript highlight following playback, and feedback with a delivery section.
11. **Replay check.** Click a "less confident" or pause marker. Pass: the audio jumps to that moment and you hear both voices in sync.

Report any failure with the step number; the call record and `analysis.json` have the timings needed to diagnose it.
