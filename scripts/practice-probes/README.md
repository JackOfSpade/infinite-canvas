# Practice-interview Phase 0 probes

Measurement probes and a live-call runner. Nothing here is imported by the app.

**Recordings and transcripts stay out of the repo.** Use a scratch directory
(`/tmp/speech-probe` below) and delete everything in it after scoring.

## A. Does Apple's on-device SpeechTranscriber keep um/uh?

Rule: if it keeps >= 80% of the reference um/uh, analysis stays local.

Requires macOS 26+ on Apple Silicon and Xcode command line tools. The first
`record` run asks for microphone permission for your terminal app.

```sh
# 1. Build into a scratch dir
scripts/practice-probes/build-speech-probe.sh /tmp/speech-probe/SpeechProbe

# 2. Record 150 s while reading scripts/practice-probes/reading-script.md aloud
#    (say every marked {um}/{uh}, and speak the [restart: ...] words)
/tmp/speech-probe/SpeechProbe record --seconds 150 --out /tmp/speech-probe/reading.caf

# 3. Transcribe the file on-device (may download speech assets the first time)
/tmp/speech-probe/SpeechProbe transcribe --in /tmp/speech-probe/reading.caf --out /tmp/speech-probe/words.json

# 4. Score
node scripts/practice-probes/filler-score.mjs --script scripts/practice-probes/reading-script.md --transcript /tmp/speech-probe/words.json

# 5. Delete the recording and transcript
rm -rf /tmp/speech-probe
```

Verdict: `local` (recall >= 0.8), `cloud` (recall < 0.8), or `INCONCLUSIVE`
(empty transcript or WER > 0.5, i.e. a bad recording; re-record).

Note: the SDK's SpeechTranscriber has no disfluency option (only
`etiquetteReplacements`), so the probe passes no transcription options.

## B. A whole live call from source, answered by chat

`live-call.mjs` runs the real call service with a stand-in for the microphone helper, so a full
call (ring, interviewer, voice, models, hang-up, recording, review) can be driven from a terminal.
Drop text files into `<outDir>/inbox` to answer as the candidate; see the header of the file for the
commands. It spends Claude usage and ElevenLabs credits.

```sh
node --import ./scripts/test-stubs/register.mjs scripts/practice-probes/live-call.mjs "$PWD" /tmp/practice-live "Quick recruiter screen, about 6 minutes"
```

It does not cover microphone capture, on-device transcription or turn-taking on real speech: those
need a spoken call in the built app.

## Tests (no network, no microphone)

```sh
node --test scripts/practice-probes/filler-score.test.mjs
```
