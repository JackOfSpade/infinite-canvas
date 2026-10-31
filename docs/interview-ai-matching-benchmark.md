# Interview AI matching benchmark

Live selection update (2026-10-30): [AI matching and two-section recall display](interview-live-ai-matching.md) describes the live path. Prompt version 2 now classifies the turn and selects a card in the same response. The generated 13-card corpus grows from the historical 63 cases to 81; prior 63-case accuracy and latency measurements used the old schema and do not validate turn classification. No real-provider accuracy or latency results for the new contract are claimed here.

This is an offline harness for choosing an AI transport for the live Interview Helper. It does not launch the app or Electron, change the live matcher, or read either the app's private data directory or the Job Search folder. Run the paid CLI calls from a normal terminal outside the Codex sandbox. The benchmark is deliberately sequential: one outstanding request across the whole run, with no automatic call retries hidden inside the harness.

The input bank is private. Keep the bank, generated utterances, and results under `/tmp/interview-match-bench` or another private directory outside the repository. Only synthetic data belongs in tests. The scripts accept the sealed `{version, recordId, bank: {cards}}` wrapper as well as a direct bank with `cards`. Each matcher receives only the card's ID, question, and one-line headline. Prepared answers remain written for the person studying them.

## Commands for Claude

Use an already authenticated Claude CLI and Codex CLI. Checking help and version does not send a model request:

```bash
cd '/Users/jack/Desktop/My Apps/infinite-canvas'
claude --version
claude --help
codex --version
codex exec --help
```

The installed Claude CLI inspected during development supports `--effort`, JSON output, `stream-json` input/output, and partial-message events. Its model aliases resolve at execution time; the benchmark records the requested alias and any resolved model returned by the CLI. Codex was absent from this development shell's PATH, so its live execution and account model access remain unverified. Set `--claude-bin /absolute/path/to/claude` or `--codex-bin /absolute/path/to/codex` when necessary. The model lists below are configurable comparison candidates; replace any Codex name with the exact model your installed CLI/account exposes. The [official Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli) describes model selection and configuration overrides.

Generate the fixed labelled set once. This command makes an AI call:

```bash
node scripts/interview-match-cases.mjs \
  --bank /tmp/interview-match-bench/real-answer-bank.json \
  --out /tmp/interview-match-bench/cases-v2.json \
  --model sonnet \
  --effort default \
  --timeout-ms 180000
```

Generate a new `cases-v2.json`; the existing corpus may mix real unmatched questions with interviewer remarks under `none`. Keep that original file unchanged. Review the new utterances and host-assigned labels before benchmarking. Check that the questions sound natural, the multi-part primary intent is unambiguous, and the `none` questions really have no adequate card. Keep the reviewed JSON unchanged for every configuration. Ambiguous cases should be corrected before the first benchmark run, with the reason recorded privately. Generating a question from a card supplies a provenance label; human review still matters when cards overlap.

For a focused check of the live default, run this exact command outside the sandbox after generating and reviewing the new cases. It makes paid calls (two sequential scored passes plus warm initialization):

```bash
node scripts/interview-match-benchmark.mjs \
  --bank /tmp/interview-match-bench/real-answer-bank.json \
  --cases /tmp/interview-match-bench/cases-v2.json \
  --out /tmp/interview-match-bench/results-turn-kinds \
  --transports claude-warm \
  --claude-models opus \
  --claude-efforts default \
  --timeout-ms 30000
```

The harness shares its timeout with warm initialization, so this measurement command allows 30 seconds to observe the full latency distribution. The live matcher retains its separate 10-second initialization deadline and 2.5-second per-turn deadline. Default effort is unchanged. Use a fresh output directory because prompt version 2 cannot resume old-schema results.

For a broader comparison, this command makes many AI calls:

```bash
node scripts/interview-match-benchmark.mjs \
  --bank /tmp/interview-match-bench/real-answer-bank.json \
  --cases /tmp/interview-match-bench/cases-v2.json \
  --out /tmp/interview-match-bench/results \
  --transports claude-cold,claude-warm,codex \
  --claude-models haiku,sonnet,opus \
  --claude-efforts default,low,high \
  --codex-models gpt-6.1-terra,gpt-6.1-sol,gpt-6-luna \
  --codex-efforts low,medium \
  --timeout-ms 30000
```

With 13 cards, the expanded matrix has up to 2,673 scored calls: nine cold Claude configurations × 81, nine warm configurations × two passes × 81, and six Codex configurations × 81. The historical 63-case matrix had 2,079 scored calls. Warm initialization adds nine unscored requests. The `default` effort omits `--effort`, ensuring a baseline for models such as Haiku even if a model rejects explicit effort controls. Start with fewer models/efforts if desired, using a separate output directory for each matrix. The harness probes CLI capabilities, bounds each call, and records unsupported or failed configurations; it does not silently substitute another model or effort. Permanent process, turn, authentication, or capability failures stop a configuration, leaving remaining cases unattempted and the configuration ineligible. A known unavailable CLI is recorded without attempting a model request. Unsupported effort combinations must not be interpreted as latency results.

A cold Claude or Codex timeout is recorded once, then its transport is closed and recreated before continuing with the next case; the timed-out case is not retried. Any call error stops a warm configuration because its conversation state is uncertain. These failures remain in the metrics and prevent recommendation.

The output directory contains `summary.csv`, `summary.md`, and `summary.json`, plus `manifest.json` for the run identity/CLI metadata and the resumable `results.jsonl` journal. Keep the whole directory private.

Repeat the exact benchmark command with the same output directory to resume after interruption. Completed records are retained. A partial warm configuration starts a new process, sends the bank again, and replays the completed prefix before measuring new cases; these replay calls cost time and tokens but do not become duplicate samples. Replayed responses must parse, and a changed card or turn kind is recorded as replay drift. Any drift makes that configuration ineligible; use a fresh output directory for a clean run. A fully completed configuration makes no new requests. A different bank, case set, prompt version, or comparison configuration needs a fresh output directory. For a clean rerun of failures, also use a fresh directory so the original evidence remains available.

To rebuild reports from saved measurements without making model calls:

```bash
node scripts/interview-match-benchmark.mjs \
  --bank /tmp/interview-match-bench/real-answer-bank.json \
  --cases /tmp/interview-match-bench/cases-v2.json \
  --out /tmp/interview-match-bench/results \
  --transports claude-cold,claude-warm,codex \
  --claude-models haiku,sonnet,opus \
  --claude-efforts default,low,high \
  --codex-models gpt-6.1-terra,gpt-6.1-sol,gpt-6-luna \
  --codex-efforts low,medium \
  --timeout-ms 30000 \
  --report-only
```

## Fixed cases and matching protocol

For a bank with `N` cards, the generator requests `3N + 42` utterances. A 13-card bank yields 81 (historically `3N + 24`, or 63, before turn classification):

| Kind | Count | Label |
| --- | ---: | --- |
| Clear paraphrases | Three per card | `question`, source card ID |
| Questions with common acknowledgement lead-ins | Ten | `question`, source card ID |
| Fixed interviewer remarks and acknowledgements | Eight | `not-question`, `none` |
| Multi-part questions | Six | `question`, explicitly primary source card ID |
| Contextual follow-ups | Six | `follow-up`, previous card ID |
| Real questions with no adequate match | Eight | `question`, `none` |
| Noisy transcription | Four | `question`, source card ID |

The generator assigns source slots and labels in code. Its AI response supplies utterance text for those slots; the AI does not choose the ground truth. Paraphrases should change vocabulary and use normal spoken wording and occasional filler. Noisy questions omit punctuation and include plausible ASR substitutions. Lead-in questions add fixed prefixes such as “Alright, thanks for that,” “Cool. Nice. So,” and “I see, that makes sense” to source-intent paraphrases. The eight non-question remarks are exact host-authored strings, including “Great. So a bit about the team: we're about twelve engineers.” Their text and labels do not depend on generator inference. Follow-ups, lead-in questions and remarks carry explicit locked-card context, so cold and warm requests have the same relevant context. Each contextual request includes `previousCardId`, the preceding utterance as `previousQuestion`, and the locked card's canonical question as `previousCardQuestion`. No ground-truth label or case category is included in a matching request. A dependent follow-up returns `kind: "follow-up"` and retains the previous card.

The minimal matching prompt asks for exactly:

```json
{"kind":"question","cardId":"a-card-id-or-none","confidence":0.9}
```

`kind` must be exactly `question`, `follow-up`, or `not-question`. Real unmatched questions return `question` with `cardId: "none"`; interviewer remarks return `not-question` with `cardId: "none"`. Strict parsing rejects missing or extra keys, unknown kinds/cards, invalid confidence, a non-question with a card, and a follow-up without the explicitly supplied valid locked card.

Cold Claude invokes `claude -p` for each utterance with JSON output and no tools. Warm Claude keeps one process per model/effort configuration using `--input-format stream-json --output-format stream-json`; it sends the card list once during initialization, then only the utterance and any explicit follow-up context. It runs the entire fixed set a second time in the same process. Codex uses a fresh `codex exec` process with `-m` and `-c model_reasoning_effort=...` for each utterance. CLI processes use an isolated working directory rather than the application repository.

Warm pass 2 shows the observed repeat-session effect. It is not a controlled measurement of provider prompt caching alone: a warm conversation also grows and includes prior predictions. Inspect any returned cache-token usage alongside the timing, and compare pass 1 when estimating a previously unheard question. Likewise, a new CLI process is process-cold; its provider may still cache repeated prompt prefixes. Configuration order, model alias changes, network load, account throttling, and machine load can all affect a single run. The fixed set makes comparisons reusable, but 39 clear cases cannot establish a production accuracy guarantee.

## Metrics and selection

Wall latency runs from sending a request to obtaining and parsing the JSON answer. Cold measurements include process startup; warm initialization and resume replays are reported separately from scored turns. Claude warm TTFT measures the first streamed output-text delta, excluding system messages and reasoning events; it is unavailable when the transport supplies only a completed response. Timing out or returning invalid JSON is a failed observation, not a fast successful result.

Each configuration/pass reports:

- p50/p95 wall latency, and p50/p95 TTFT where available.
- Overall selection accuracy (both turn kind and card correct), turn-kind accuracy, clear-paraphrase accuracy and lead-in question accuracy. Failed calls and invalid JSON remain in the accuracy denominator.
- Non-question precision/recall, distinguishing interviewer remarks from real unmatched questions even though both use `cardId: "none"`.
- `none` precision: correctly abstained `none` cards divided by all predicted `none` cards. `none` recall: correctly abstained `none` cards divided by all labelled `none` cases (real unmatched questions and non-question remarks). These card-only metrics are separate from turn classification. A zero denominator is unavailable rather than 100%.
- Follow-up handling: returning the previous card with `kind: "follow-up"`. A card match classified as a new question does not pass this metric.
- JSON/schema-parse failure rate, call failures, completed count, and confident false card selections on `none` cases. Confidence at or above 0.8 counts as confident.

The recommendation requires a complete configuration/pass, at least 95% accuracy on clear paraphrases and turn kind, correct classification of every non-question case, zero parse or call failures across the set, zero confident card selections on `none` cases, and no warm replay drift. A warm configuration must meet these gates in both passes; selection uses its pass 1 latency because pass 2 repeats previously seen questions. The report ranks eligible pass 1 rows by p50 latency, using p95 to break ties. A bridge latency supplied separately has no measured matching accuracy and cannot win this recommendation. If no row qualifies, the report says so. The fastest qualifying configuration can still miss the latency target; the report calls that out separately.

The live target is a card on screen within about 1.5 seconds after the interviewer stops. The matcher still times out at 2.5 seconds; the benchmark report retains its historical 3-second matching-only comparison ceiling, which is not the live target. This harness measures the matching portion. ASR endpointing, question detection, bridge queues, IPC, and painting also consume that budget. A CLI p95 below 3 seconds alone does not prove the full live path meets the target.

## ChatGPT bridge measurement

The app's existing bridged ChatGPT conversation cannot be driven by this standalone script. For a separately authorized in-app measurement session, use the same reviewed utterances and compact-card protocol and record monotonic timestamps at these points:

1. `tQuestionEnd`: the last interviewer audio sample for the question, or a clearly documented manual equivalent.
2. `tSend`: the matching request enters the bridge, after transcription/question detection.
3. `tFirstText`: first answer text becomes observable, if the bridge exposes it.
4. `tParsed`: valid matching JSON is available to the host.
5. `tPaint`: the chosen answer card is painted in the live window.

Compute `tParsed - tSend` for a comparison with CLI wall latency, `tFirstText - tSend` for observable TTFT, and `tPaint - tQuestionEnd` for the actual live requirement. Also retain predictions against labels to measure bridge accuracy independently. Measure cold and reused bridge chats separately, without changing prepared cards to improve matching. This document does not require launching the app to run the CLI benchmark.

After obtaining an actual bridge measurement, add its scalar comparison using the same benchmark command and:

```text
--bridge-latency-ms 1450 --report-only
```

Here `1450` is only an example: substitute the measured bridge p50 for `tParsed - tSend` in milliseconds. The report marks it as supplied context, with no inferred p95, accuracy, TTFT, or recommendation eligibility. Keep the underlying timestamps, sample count, and p95 in the private bridge measurement notes.

## Local verification without model calls

The registered test file `scripts/tests/interview-match-benchmark.js` injects a stub transport and uses temporary synthetic data. It checks scoring, tables, rejection of a fast unsafe matcher, strict output parsing and locked-card context, kind and joint selection scoring, non-question recall gates, both warm passes, completed and partial resumes, changed-input rejection, failure stopping, timeout cleanup/continuation, unavailable CLIs, replay drift, and host-assigned generator labels/counts. Run only that test group without starting the app:

```bash
node --import ./scripts/test-stubs/register.mjs scripts/test-runner.js interview-match-benchmark.js
npm run lint
```
