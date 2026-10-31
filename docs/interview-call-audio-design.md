# Interview call audio — design and verification

Live selection update (2026-10-30): [AI matching and two-section recall display](interview-live-ai-matching.md) now supersedes the lexical-only live-flow descriptions below. The separate benchmark is still the authority for choosing transport/model/effort defaults; no benchmark scripts were changed.

Design recorded before implementation, 2026-10-30. Scope: the restricted live Interview Helper child only. Read `interview-helper-ux-audit.md` first. This does not change application generation; its private counter is not accessed because the user explicitly prohibited its containing directory. All pre-existing working-tree changes are retained.

## Decision

Choose **(b), a small signed Swift ScreenCaptureKit helper with Apple SpeechAnalyzer / SpeechTranscriber**, targeting macOS 26+ on Apple Silicon. Capture the system's output mix, excluding Infinite Canvas and the helper. This is intended to cover Zoom, Meet in Chrome, Teams, Webex and FaceTime independently of their window or Space; that coverage still requires the live checks below. It also hears unrelated applications: pause other media. This initial implementation does not claim per-app isolation or speaker diarization. Remote echo or another participant replaying the candidate's voice is output audio and cannot be reliably separated from the interviewer by this tap.

Use `SCStreamConfiguration.capturesAudio = true`, `captureMicrophone = false`, `excludesCurrentProcessAudio = true`, a display content filter excluding the host app's processes, and **only** an `.audio` stream output. No screen output/recording output is registered, and no images are processed or retained. A display filter is a ScreenCaptureKit setup requirement, not a video recording feature. No microphone capture, virtual/aggregate devices, output routing, default-device changes, muting, ducking, volume controls, audio engine playback or feedback path is present. The call continues using its existing playback and microphone. A system-output stream is independent of a chosen hardware output device; conversion accepts new input formats, and a capture interruption may restart the read-only stream without modifying devices.

### Alternatives checked

* Electron 44.4.5's [`setDisplayMediaRequestHandler`](https://github.com/electron/electron/blob/v44.4.5/docs/api/session.md) accepts loopback capture. The versioned [`desktopCapturer` documentation](https://github.com/electron/electron/blob/v44.4.5/docs/api/desktop-capturer.md) and [current permission caveats](https://www.electronjs.org/docs/latest/api/desktop-capturer#macos-versions-142-or-higher) must be read together: Chromium uses Core Audio taps by default since Electron 39; assuming ScreenCaptureKit underneath on this Mac is incorrect. Permission denial can yield an already-ended silent audio track. A browser transport would still need native local speech recognition and add a renderer PCM bridge. Avoid `loopbackWithMute` entirely. The built-in route adds little benefit here.
* Core Audio process taps (14.4+) can isolate call processes, but require managing taps/aggregate capture resources and process identity (including browser audio services). They add failure modes without improving this task's allowed system-output scope. No such APIs are used.
* [Apple's SpeechAnalyzer presentation](https://developer.apple.com/videos/play/wwdc2025/277/) describes the on-device long-form model and volatile streaming results. It avoids bundling whisper.cpp plus hundreds of megabytes of weights and avoids a separate inference runtime/CPU budget. Local installed SDK declarations are the compile-time authority. Use fast volatile results rather than waiting for final transcription. No SFSpeechRecognizer server fallback is allowed. First use may download Apple-managed language model assets using AssetInventory before any capture, audio or transcript exists. Capture starts only after installation completes; failed/offline preparation is visible and retryable. Audio and transcripts never enter the asset-download path. English (en-US) is the initial supported recognition locale.

## Process and privacy boundary

Main owns one helper per live child session. Spawn an absolute app-owned executable with argv, no shell, piped stdin/stdout/stderr, and no transcript logging. Fixed NDJSON protocol:

* helper → main: `{type:'status',state:'preparing'|'listening'}`, `{type:'activity',speaking:boolean}`, `{type:'transcript',text,segmentId,final,startMs,endMs}`, `{type:'error',code}`. Segment ranges identify replacements; main supplies its own monotonic arrival time. Audio never crosses IPC.
* main → helper: stdin EOF on stop; SIGTERM as a prompt fallback, bounded SIGKILL if necessary. Parent death also stops capture. No audio or transcript files, local database writes, telemetry or external AI calls. OS-installed speech model assets are not session data.
* service → child: bounded `{status,transcript,question,errorCode,message}` via `interview-window:listening-updated`. Only fixed error messages cross this boundary. Start/stop/get/use IPC is bound to the exact live child and its main frame; parent/sibling/subframe senders cannot control it. Renderer supplies no process, executable path or transcript text.

Stop, child close/crash/navigation, owner close/deletion, or session retarget stops the helper and clears transcript/detector memory. Late native messages and pending automatic lookups are generation-fenced. No transcript is put into canvas state. The selected question/answer remains in the ephemeral live view until Next/close, as with typed questions. There is no save action in this feature.

## Questions and answer locking

Endpoint using approximately 800 ms of output silence plus a short transcript-stability interval. RMS activity is not a speaker classifier; a new output speech turn ends the old quiet interval. Partial revisions replace segments instead of appending duplicates. Final ASR results alone cannot endpoint while output speech continues. Do not cut at every question mark. Preserve the full bounded turn, including adjacent follow-ups; abstain on oversized turns rather than silently clipping a question.

Native recognition finalizes through the current audio position after about 650 ms of quiet without ending its long-lived analyzer. Main waits for 800 ms of quiet plus 250 ms of stable text; this targets about 1–2 seconds after speech, including recognition and display. OS/model load and a busy main event loop can add delay. No live latency result is claimed.

Question-likeness is deterministic: interrogatives and interview prompts such as “tell me about”, “walk me through”, “describe”, “how would you”; tightly recognized dependent follow-ups reuse the existing follow-up grammar/story anchor. Statements and uncertain fragments remain visible with **Use this question**. Multipart questions are checked against the existing prepared matcher; incompatible independent parts do not silently choose only the last card. The override lets the user explicitly submit the whole visible turn. Existing match/evidence abstentions remain truthful.

Opting into Listen authorizes distinct detected questions to advance the existing locked-question flow. A recognized dependent follow-up keeps the selected story when supported. Manual entry remains available and errors never disable typing. Stop stops automatic advancement. Repeated/final revisions cannot resubmit an already-ended turn.

Automatic matching uses the snapshot and answer bank already validated at child launch (or its latest successful manual lookup). These are frozen for that live session and never persisted by listening. Parent updates adopt their own freshly validated snapshot with the existing Next-question transition. This removes repeated filesystem/seal work from the audio endpoint latency path. Manual submission keeps its current authoritative revalidation. No live AI generation is introduced.

## UI and permissions

Always-visible Listen/Stop control and status, including while a card is locked. Clearly label **Listening · system output · microphone excluded** and explain that cards advance automatically. Show a compact live transcript and **Use this question**, plus the typed fallback. Starting is cancellable. Errors/permission denial leave typing usable.

ScreenCaptureKit can require **System Settings → Privacy & Security → Screen & System Audio Recording** (wording varies by OS) even for output-only samples. Request only when Listen is clicked. Explain the screen-category wording and that this feature registers only audio output. If denied, enable Infinite Canvas / Interview Audio Helper under that setting and retry. macOS can require a user-directed later restart for a changed grant; never quit/relaunch the app automatically. For development TCC may attribute the request to the responsible terminal/IDE; validate the signed packaged build separately. No microphone or server-based Speech authorization is requested.

**No-audio limitation:** Listening confirms that ScreenCaptureKit accepted the stream start; it does not certify that audible call samples or recognized words have arrived. A quiet system can legitimately deliver no useful audio, so a lack of PCM alone is not a permission-failure timeout. If a clearly audible prerecorded question produces no transcript, stop, check the screen/system-audio grant and that the sound is playing from another application, then retry or continue typing. This case requires live verification on the signed build. On capture recovery the helper pauses samples, finalizes and cancels the old ASR range, and rejects results predating the recovery boundary before resuming with the same audio timeline.

## Packaging

Compile the helper alone with `swiftc` (macOS 26 deployment target) into a small `.app` resource with a stable bundle identifier and privacy Info.plist. Add an electron-builder `extraResources` entry. `scripts/build-macos.mjs` compiles/signs the helper before packaging with the existing pinned `build.mac.identity`; it retains the final strict deep signature gate. Sign helper with hardened runtime and minimal entitlements (no microphone/audio-input, network or device mutation entitlements). Do not weaken host hardened-runtime settings or change the identity. Development requires an explicit helper build; Listen fails clearly if it is absent. Never compile code on Listen.

## Validation and live procedure for Claude

Automated: transcript fixture tests for silence, revisions, final timing, statements, multipart questions, independent/dependent follow-ups, dedupe, bounds and prepared matcher integration; fake-process service and controller tests for authorization, lifecycle races, stop and fixed errors; mounted UI checks; a static capture-boundary check banning device mutation/output/playback/microphone APIs; build/signing configuration checks. Register new suites in `scripts/test-runner.js`. Run the interview runner and `npm run lint`. Compile the Swift helper with `swiftc` into `/tmp` only; do not execute it or invoke electron-builder during this task.

Claude's later live test requires explicit authorization to build/launch the changed app; **none is performed in this implementation session**:

1. With that authorization, package normally using `npm run build` (pinned identity). Verify the nested helper and outer bundle with `codesign --verify --deep --strict`. Open an already prepared Interview Helper window.
2. Start Listen and accept Screen & System Audio Recording if prompted. Wait for the visible Listening indicator (model preparation is separate). Play a consented prerecorded English interview question from another application's normal system output, for example `afplay /tmp/interview-question.wav` using an explicitly supplied synthetic recording. Verify live words and a matching card about 1–2 seconds after playback speech ends. Measure from the audio ending to the visible card; record first-use/model warmup separately. This latency is a target, not a measured guarantee.
3. While playback continues, verify it stays audible at the same volume. Speak into the call microphone while the remote side stays silent: no candidate transcript should appear. Confirm the call's other participant can still hear the candidate. Never change devices through the helper. Check multiple call apps separately (Zoom, Chrome Meet, Teams, Webex, FaceTime).
4. Move the call to another window and Space; repeat. Plug/unplug headphones using macOS normally and repeat; verify capture continues or reports/recoverably restarts without altering macOS routing. Test permission denial/revocation, cancelled startup, absent assets and a capture interruption. Typed questions must remain usable in every case.
5. Test a multipart question, a dependent “what did you learn?”, an unrelated statement, an unmatched question and the override. Verify honest abstention, the lock/advance behavior, no final-result duplicate and no delayed card after Stop.
6. Click Stop: indicator becomes idle and transcript clears; no further words/cards arrive. Restart and close the child, then repeat with owner close: helper process exits promptly. Inspect only synthetic temporary artifacts/logs; there should be no recording/transcript file. Do not inspect either prohibited private directory without new user authorization.

## Implementation files

| Area | Files |
| --- | --- |
| Capture lifecycle and native protocol | `electron/interviewCallAudio.js` |
| Silence, revisions and question/multipart gates | `electron/interviewCallQuestionDetector.js` |
| Child-bound IPC, local cached lookup, locking and cleanup | `electron/interviewWindow.js`, `electron/interviewWindowPreload.js` |
| Native capture, speech, privacy and entitlements | `native/interview-audio/InterviewAudioHelper.swift`, `Info.plist`, `entitlements.plist`, `.gitignore` |
| Listening controls, transcript, override and typed fallback | `src/interview-window/CallAudioPanel.jsx`, `InterviewWindowApp.jsx`, `interviewWindow.css` |
| Compile, pinned signing and macOS resources | `scripts/build-interview-audio-helper.mjs`, `scripts/build-macos.mjs`, `package.json` |
| Regressions and registration | `scripts/tests/interview-call-audio.js`, `interview-call-audio-render.js`, `interview-call-question-detector.js`, `scripts/fixtures/interview-call-transcripts.mjs`, `scripts/test-runner.js` |

## Verification results

* `node --import ./scripts/test-stubs/register.mjs scripts/run-interview-tests.mjs`: **356 passed, 1 failed across 25 suites**. All 28 new listening checks pass (9 service/IPC/privacy, 6 mounted UI, 13 detector/fixtures). The failure is the existing `interview-window-e2e.js` Chromium launch abort before renderer startup (`SIGABRT`), also recorded in the earlier UX audit. No passing browser end-to-end or live-audio result is claimed. Log: `/tmp/interview-call-audio-verified-suites.log`.
* `npm run lint`: passed. Log: `/tmp/interview-call-audio-verified-lint.log`. `git diff --check`: passed.
* Existing `packaging-integrity.js`: 6/6 passed using its isolated tests, without packaging an application. Final controller-focused rerun: 40/40 passed.
* `node scripts/build-interview-audio-helper.mjs --output /tmp/interview-call-audio-helper-compile`: clean `swiftc` compilation, Swift 6.4.2, `arm64-apple-macos26.0`, approximately 211 KiB executable. The compiled helper was **not executed or signed** in this task. No Electron, application build or electron-builder invocation occurred.

Live ScreenCaptureKit/TCC attribution, call-app/Space coverage, headphone changes, recognition quality, OS asset installation, playback continuity and the 1–2 second target remain unverified. Follow the authorized live procedure above. The feature's recognition locale is initially English (en-US), and its capture scope is system output rather than one selected call process. All pre-existing edits remain; neither prohibited private directory was accessed and no commit was made.
