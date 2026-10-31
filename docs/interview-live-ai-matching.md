# Interview live AI selection and recall display

Implemented offline on 2026-10-30. This supersedes earlier descriptions of a lexical-only live matcher in the UX audit and call-audio design. The benchmark now measures turn classification as well as card selection; historical measurements below used the earlier selection contract. No production app, Electron, live AI provider, private application store, or Job Search directory was used in this implementation session.

## Speculative matching

While **Listen** is active, committed transcript fragments plus the current replaceable volatile tail feed a pure, event-driven speculative scheduler. Partials and the endpoint share the detector's turn ID. At least three words and the existing pure-filler exclusion are the only lexical gates. Each additional word can dispatch the latest text; occupied sessions retain only the newest revision, never a stale FIFO. Closed-turn and out-of-order results are discarded. Typed questions, typed follow-ups, prepared-card choices and **Use this question** detach speculation without killing healthy warm processes.

The independent `display.preview` is a sealed bank-card projection, never model-authored answer text and never a change to the locked answer. Show at confidence **≥0.6**. Switching cards requires two consecutive qualifying results for that challenger, or **+0.15** confidence over the current preview. Two consecutive misses each based on at least two more words than the preview clear it. Preview notifications change only on a card change, confidence rounded to **0.05**, or clearing. Endpoint, Stop, explicit choices and window close clear it. A latest speculative result whose text matches the endpoint (case, whitespace and trailing punctuation normalized), with question/follow-up kind and the normal matching confidence threshold (**0.55** by default), locks immediately with `source: 'speculative'`; otherwise an identical normalized in-flight request is awaited under its existing timeout and the same acceptance rules with `source: 'speculative-inflight'`, falling back to the ordinary final call on failure while preview clears immediately and explicit user requests retain priority. A not-question final leaves the locked card untouched.

The matcher warms **4** independent sessions by default (≈100 MB each). Configure `poolSize` or `INTERVIEW_MATCH_POOL_SIZE` (clamped **1–4**); at most `poolSize - 1` sessions speculate, reserving a session for final/explicit requests. Size **1** disables speculation. Each session retains its own timeout, detach/drain and recovery lifecycle. Speculative calls add `partial: true` only to the per-turn message, asking for a calibrated prediction of where the unfinished question is heading; the system prefix and strict `{kind, cardId, confidence}` schema stay shared with final calls.

Real Opus measurements on the 13-card bank: 59 answerable questions at **40/60/80%** word prefixes selected the correct card **47% / 81% / 95%** of the time, with median correct confidence **0.60 / 0.75 / 0.85**. Every wrong-card result had confidence **≤0.5** (none ≥0.8). Calls took about **1.2 s**; full-question accuracy was about **99%**, p50 **0.9 s**. These measurements motivate the 0.6 preview threshold; they are not new measurements from this implementation.

Replay outside the sandbox with real local Claude (no app launch):

```sh
node scripts/interview-speculative-replay.mjs --bank /private/bank.json --cases /private/cases.json --out /private/speculative-results --pool 1,2,3 --rate 2.6
```

The replay uses the production scheduler and matcher, streams words at the specified words/second rate, and writes private `summary.json` and `summary.md` outside the checkout. It reports correct-early-preview coverage among answerable cases, median/p10 lead time, any-wrong-preview rate, final latency, instant-lock percentage and selection calls per case. Unit tests use fake matchers and clocks; no real providers are required. Warm-up is excluded from utterance timing. Provider recovery may add transport calls beyond the reported scheduler selections.

## Selection and two phases

Typed questions, transcript overrides, detected audio questions, and parent-provided questions use the same main-owned semantic matcher. Even an exact catalog question entered as text invokes AI. Prepared-question buttons and card chips are explicit choices: they call `interviewAPI.selectPreparedCard(cardId)` through `interview-window:select-prepared-card`, bound to the live child sender and main frame. Main reloads and validates the displayed snapshot/bank pin, opens that saved card directly, and labels it **Prepared answer selected**. No AI matching call or provider wait is involved. A manual choice supersedes any pending selection; late AI results cannot overwrite it. The display exposes only each card's ID and question through `briefing.preparedCards`, alongside the existing question strings.

The AI response validates strictly as `{kind, cardId, confidence}`, where `kind` is `question`, `follow-up`, or `not-question`. Unknown IDs/kinds, missing/extra fields, malformed JSON and incompatible follow-up IDs fail closed. A follow-up requires the explicit locked card ID; a non-question requires `cardId: "none"`. A real unmatched question uses `kind: "question", cardId: "none"`. Parsing accepts whitespace, code fences and surrounding prose by extracting the first balanced JSON object, respecting quoted braces and escapes; it never skips an invalid first object to find a later valid selection. A content/schema failure falls back for that turn while keeping a healthy warm transport. An AI `none` or low-confidence result never silently becomes a lexical prepared card; an uncertain follow-up preserves the current display via the non-question notice. Exact saved evidence may still be shown with an approximate relevance label. No live response can author or modify a career claim.

### What AI decides in Listen

Every endpointed non-filler turn reaches AI in full, including acknowledgements, short questions, company information and multipart turns. AI decides whether it is a new question, a dependent follow-up, or not a question, and selects a card in the **same call**. Word counts, question-shaped wording, trailing prepositions and uncertain lexical context cannot reject a live turn: natural interviewer wording varies too much. The request includes the locked card's ID and canonical prepared question (`previousCardId`, `previousCardQuestion`) plus the previous turn (`previousQuestion`). A queued newer bank cannot replace the locked bank during a follow-up.

Only empty/pure-filler turns (for example “Alright. Cool. Mm-hm.”), length limits, and stale/retired segment protections remain local gates. Silence/stability still endpoint speech locally. Overlapping ASR revisions with shifted segment IDs replace volatile fragments rather than appending stale leading words; finalized and retired ranges remain protected. A `not-question` response leaves the identical locked display, anchor and pin untouched, emits no replacement update, and offers the transcript's existing **Use this question** notice. Questions replace the card or use the honest unmatched display; follow-ups continue the locked card.

If AI is unavailable or expires, the existing conservative non-semantic detector gates the **Approximate** fallback, including its multipart checks. It recognizes ordinary lead-ins such as “cool”, “I see”, “that's helpful”, and “next one”. Classification adds no round-trip and does not raise effort: warm Opus/default effort and the shared **2500 ms** deadline remain. The prior roughly 0.9-second matching measurements do not verify the updated contract's quality or the **~1.5-second end-to-end** target; rerun the labelled benchmark and a live audio test outside the sandbox.

Phase 1 publishes the memorized headline, bullets and separately cited example as **Your prepared answer** immediately after selection. Section B is dedicated optional material the human has **not** memorized. Prepare now asks for `extensions` on **every** card in the existing answer-bank handoff: 2–4 short points, each at most 18 words/220 characters. They answer the question more completely with another angle, project, skill, role-fit fact, documented lesson or tradeoff. A point must add a supported detail beyond the entire prepared answer, including its example. It may cite a different career story or unused detail in the same complete source. Why-company/why-role points may instead cite unused sealed research, kept separate from candidate experience. The host derives a small project/role/research **example hook** from that point's sealed source labels; the model cannot invent a hook.

This replaces the earlier example-promotion design. The reported real-app Prepare produced zero optional candidates on all 12 cards because the single examples were too long or repeated memorized details. Examples are no longer promoted into section B. New Prepare handoffs carry compact `extensions:[{id,text,evidenceIds}]`; the host restores full exact quotes from those content-addressed IDs before mechanical checks or semantic review. The sealed bank retains `extensions:[{id,text,evidenceIds,quotes}]`, so the source toggle and record hash bind the complete evidence. Omitting repeated full paragraphs from extension wire output keeps it within the existing output budget. Fresh Prepare drafts must contain an explicit extensions field on every card; legacy sealed banks remain readable with no fabricated extensions. A new Prepare is required to generate them.

Each point passes the same complete-quote binding, entity, number, content-word, ownership and candor guards as card claims. Inherited, co-built, team-chosen and supported-only qualifications remain mandatory. Points repeating the prepared answer or earlier surviving points are rejected. Sibling detail deduplication runs after semantic rejection, so a false proposition cannot displace identical wording bound to genuinely supporting evidence. Mechanically surviving extensions enter the same independent semantic entailment review, bound to their ID, question, path, text and exact evidence IDs by a claim digest. Shared vocabulary cannot approve a new proposition. The review includes extension paths and supports up to 180 claims; cited evidence is sent once per review rather than repeating full source paragraphs for every claim.

Optional failures drop **individually** before sealing and after semantic review. They cannot send an otherwise safe card through destructive repair or make the bank fail its card floor. Safe siblings remain. Existing sparse card repair, locked passing cards, required-card narrowing and degradation still apply; repaired cards are asked for their extensions in the same handoff. Sealed extensions and their additional evidence participate in the bank's content-addressed record ID and input bindings. A card may honestly retain fewer than two, including zero, when proposed additional claims cannot be grounded; the host never fills a quota with invented facts.

Section B starts collapsed, remains visually secondary, and says **Optional, bring in only if you can back it with an example**. Each glanceable point has its example hook, source attribution and exact-evidence links. Selecting a card exposes all its approved points without another live generation or ranking call. Copy answer preserves section A first, followed by the optional label, caution, points and hooks. A card with no valid points omits the optional section in both display and copy.

Every response, including exact-evidence and unsupported results, offers a compact **Other prepared answers** picker with every saved card question. One tap replaces the response by ID, without Next or an AI call. Choices remain available during a slow typed lookup and supersede it immediately. The typed replacement form remains available as well. Picker usability is covered with DOM interaction tests; actual one-second response latency has not been measured in the running app.

## Transport lifecycle and configuration

`electron/interviewAiMatcher.js` owns parsing, deadlines, confidence, cancellation, deterministic fallback and the last 30 AI latency observations. `electron/interviewAiTransports.js` implements a small `start({cards,extensions,instructions,signal})`, `match({question,previousCardId,previousQuestion,signal})`, `close()` interface. The controller accepts an injected factory, config, request function and matcher for tests/integration.

| Transport value | Behavior |
| --- | --- |
| `claude-warm` | One persistent Claude CLI process with stream-json input/output. Window open starts initialization; compact card IDs/questions/headlines plus approved extension IDs/text and example hooks are sent once. Later turns contain only the question and explicit previous-card context. Window close retires the process. |
| `claude-cold` / `claude-one-shot` | Claude CLI print call per question; the session retains the bounded prefix in host memory. |
| `codex` | Codex CLI exec call per question with explicit model/effort and tool restrictions. |
| `chatgpt-bridge` | Existing `requestNonApiAi` route, task `interview-live-match`, bound to the canvas owner rather than exposing a general child AI API. Uses the existing bridge schema/abort handling. |

CLI capability checks run through help before provider calls. Calls use isolated temporary working directories, no shell interpolation, bounded stdout/stderr, tool restrictions and abort-driven process termination. Temporary CLI resources are cleaned up. The host retains no live matcher transcript log. CLI and bridge providers retain their existing service/account behavior; the ChatGPT bridge's durable handoff policy is unchanged.

One matcher lifecycle belongs to the live window. Next question reuses its context and latency observations. A changed validated bank/pin replaces the matcher; close, crash, owner deletion and owner close release it. A question timeout or cancellation while waiting for initialization ends only that question: startup continues under its independent `initTimeoutMs` deadline, and the expired question is never dispatched when startup finishes. Later questions reuse the ready session. Initialization failure/expiry, protocol/process failures, and timeouts or cancellation after dispatch retire uncertain transport state; the next question can initialize a fresh transport. Invalid selection content/schema alone does not retire the warm transport. Late initialization/results are fenced. Claude warm is the adapter with a real persistent provider conversation. One-shot CLIs and the existing bridge do not gain a provider warm-session API: the bridge currently inlines its cached prefix for each handoff and uses its existing ChatGPT chat/model. Model/effort configuration directly controls the CLI adapters; bridge model selection remains in ChatGPT.

The measured default is **`claude-warm`, `opus`, default effort**. The historical selection benchmark used the real **13-card bank and 63 labelled utterances**, across both warm passes in all four stages; it predates turn classification. The user's criteria are the **fastest configuration where quality stops improving, which must also stay fast under heavy machine load**. An isolated fast median is insufficient: later quiet runs, tail latency, abstention quality and loaded runs all count.

| Configuration / conditions | p50 seconds | p95 seconds | Top-1 | `none` recall | Evidence / decision |
| --- | ---: | ---: | ---: | ---: | --- |
| **Opus warm / default, quiet confirmation** | **0.867** | **0.950–0.996** | **100%** | **100%** | Stage 3, both passes; selected |
| **Opus warm / default, heavy CPU load** | **0.834–0.866** | **0.904–0.969** | **100%** | **100%** | Stage 4, all cores but two busy; selected |
| Opus warm / default, initial comparison | 1.022–1.032 | 1.138–1.158 | 100% | 100% | Stage 2; quality holds across every Opus run |
| Opus warm / high effort | 0.958–1.017 | 1.154–1.177 | 100% | 100% | Stage 2; no quality gain, about 1.0 s median |
| Sonnet warm / default, early run | 0.707–0.708 | 0.780–0.787 | 100% | 100% | Stage 1 alone suggested a winner; superseded by later runs |
| Sonnet warm / default, later quiet runs | 0.805–2.812 | 4.941–8.136 | 98.4% | 87.5% | Stages 2–3; misses one `none`, disqualified |
| Sonnet warm / default, heavy CPU load | 1.974–2.054 | 5.933–7.179 | 98.4% | 87.5% | Stage 4; fails latency and quality criteria |
| Haiku warm / default | 1.272–1.285 | 1.400–1.537 | 100% | 100% | Stage 1; slower than selected Opus |
| Codex `gpt-6.1-terra` / low effort | 2.970 | 5.886 | 100% | 100% | Stage 1; too slow for live matching |
| ChatGPT bridge | ≥45 per handoff | Unmeasured | Unmeasured | Unmeasured | Separate real in-app Prepare repair rounds; unusable for live matching |

Sources: `/tmp/interview-match-bench/results-stage1/summary.md`, `results-stage2/summary.md`, `results-stage3-quiet/summary.md` and `results-stage4-loaded/summary.md` in the same benchmark directory. Ranges span the two warm passes (and stages where specified); they are not pooled percentiles. Every listed benchmark run completed all 63 utterances. Opus retained 100% top-1 and 100% `none` recall in every run, including the loaded confirmation. Default effort is the diminishing-returns point: high effort adds no quality, while default effort supplies the demonstrated sub-second quiet and loaded tails. High effort was not separately tested under heavy load. Sonnet is disqualified even on a quiet machine by its later 4.9–8.1 second tails and missed abstention, as well as its loaded performance. The benchmark scripts' per-stage recommendations do not replace these cross-stage selection criteria.

The bridge bound comes from separate real handoffs; it was not measured by the transport benchmark. It remains explicitly selectable for diagnostics or other workflows and is never the live default. Benchmark matching times exclude warm initialization, speech endpointing and rendering; they do not establish total live response time. The chosen matching latency supports the normal two-section display and does not justify making Keep going the primary layout.

Main-process configuration is read from the environment; the child cannot supply binaries, model names or transport instructions. The AI deadline starts after the existing authoritative snapshot/bank validation; it does not bound filesystem validation or renderer scheduling.

| Environment variable | Default |
| --- | --- |
| `INTERVIEW_MATCH_TRANSPORT` | `claude-warm` |
| `INTERVIEW_MATCH_MODEL` | `opus` |
| `INTERVIEW_MATCH_EFFORT` | `default` (no explicit effort flag) |
| `INTERVIEW_MATCH_TIMEOUT_MS` | `2500` total per question, including remaining initialization and any cold retry; expiry while warming leaves startup running |
| `INTERVIEW_MATCH_INIT_TIMEOUT_MS` | `10000` independent initialization deadline |
| `INTERVIEW_MATCH_LATENCY_THRESHOLD_MS` | `2500` |
| `INTERVIEW_MATCH_CLAUDE_BIN` | `claude` |
| `INTERVIEW_MATCH_CODEX_BIN` | `codex` |

The default fallback order is **warm Opus → cold Opus at default effort → deterministic Approximate matching**. A warm failure or invalid selection can retry through `claude-cold` inside the same 2500 ms question budget. Cold Opus is a recovery route; these summaries do not establish its latency. A full timeout exhausts that budget and goes directly to Approximate; it does not add another provider wait. Explicit bridge, Codex and cold selections use their selected transport followed by deterministic matching. Busy calls also fall back without launching another AI turn. The deterministic result is labelled **Approximate · fallback matching**. Timeout results cannot arrive later and overwrite it. A successful AI abstention or low-confidence result does not trigger another provider or deterministic prepared-card selection. The audio fallback retains the conservative multipart/story gate only after AI fails; the semantic path sees the full endpointed turn instead of lexically choosing its tail. Audio capture/ASR remains local; submitting the turn to AI is part of live matching. No raw audio is sent to any AI transport.

## Latency layouts

The default **Automatic** mode starts with the normal two-section **Recall** layout: **Your prepared answer**, followed by the collapsed **Optional extension** when available. It selects **Keep going** only as an automatic fallback when observed AI p50 exceeds 2.5 seconds (configurable). Timed-out calls count as slow observations; immediate unavailable-adapter errors do not masquerade as measured AI latency. Recall leads with the headline and memorized bullets. Keep going puts action/result cues before setup and uses larger bullets, a secondary headline and the prompt “Keep going in your own words. Glance at a cue when ready.” Both layouts use identical approved text. Optional details stay collapsed in either layout. The main-owned selector offers Automatic and Recall, survives question changes and accepts only those two values through a child/main-frame-bound IPC route. Keep going cannot be forced through the selector or its IPC route.

The compact speaking surface (including the 420×640 always-on-top case) now puts the locked question and section A ahead of the layout selector, listening panel and other-answer picker. These tools remain available below the response; the listening panel stays mounted through the transition so capture continues. The optional extension still starts collapsed and resets on a changed card/question. At widths up to 520 px, the audio panel no longer sticks over the answer during focus scrolling. Essential Follow-up, Next question and Copy controls stay pinned to the bottom in a compact bar with 34 px minimum button heights and 7 px vertical padding. The 76 px bottom padding and scroll margin reserve room for that prepared-answer control bar. The headline and bullets retain the existing compact type sizes and complete approved wording; no clipping or truncation is used to make them fit. The mandatory Chromium assertion still requires the headline, every bullet and essential controls to fit in the viewport.

## Atomic audio replacement

The old `advanceQuestion(childEvent, false)` before an awaited answer lookup is removed from automatic audio and transcript override paths. A replacement computes its complete display against the target validated pin while retaining the old display, lock and anchor. Only a current successful result commits the replacement and emits `brief-updated`. Failure, Stop, supersession, child close and stale native endpoints cannot leave main cleared while the renderer shows the previous card. A pending parent pin is adopted only with a successful replacement or explicit Next.

## Verification

| Area | Files |
| --- | --- |
| AI contract, fallback, measurements and CLI/bridge adapters | `electron/interviewAiMatcher.js`, `electron/interviewAiTransports.js` |
| Dedicated extension generation, sparse validation, sealing and Prepare guidance | `electron/ipc/interviewAnswerExtensions.js`, `electron/ipc/interviewAnswerBank.js`, `interviewAnswerEntailment.js`, `interviewPreparation.js` |
| Child lifecycle, atomic replacement, audio gate and mode IPC | `electron/interviewWindow.js`, `electron/interviewWindowPreload.js`, `electron/interviewCallQuestionDetector.js` |
| Recall/continuation display and copy | `src/interview-window/InterviewWindowApp.jsx`, `interviewWindow.css` |
| Owner-bound handoff context and reviewed task registration | `electron/ipc/ipcUtils.js`, `llm.js`, `nonApiAi.js`, `handoffBridge/controller.js`, `engine.js`, `telemetry.js` |
| Regression suites | `scripts/tests/interview-ai-matcher.js`, `interview-ai-window.js`, `interview-preload.js`, `interview-prepared-picker-render.js`, `interview-answer-extensions.js`, `interview-answer-sections-render.js` |
| Registration and existing offline fixture adaptation | `scripts/test-runner.js`, `scripts/tests/interview-answer-live.js`, `interview-call-audio.js`, `interview-window-render.js`, `interview-window-e2e.js`, `scripts/interview-window-controller-session.mjs`, `scripts/interview-window-e2e.mjs` |

Registered suites cover stubbed AI picks, none, follow-ups, timeout and labelled lexical fallback; slow startup surviving multiple question deadlines, independent initialization expiry, tolerant parsing and healthy-session reuse; compact warm initialization, one-shot/Codex/bridge adapter protocols; recovery and cancellation; invented-fact, duplicate and candor rejection; individual mechanical/semantic extension drops; realistic replay survival of at least two points per card; section order/collapse/copy, hooks and empty-extension omission; p50 and manual layout changes; child authorization and direct card-ID validation; all-card pickers after every response, duplicate question labels and late-AI fencing; and atomic audio failure/supersession. The new picker suite is registered in `scripts/test-runner.js` and automatically discovered by the interview runner. Existing offline fixtures explicitly inject an unavailable AI transport so they never contact a provider. Run:

```bash
node --import ./scripts/test-stubs/register.mjs scripts/run-interview-tests.mjs
npm run lint
npm run test:unit
```

Tests use synthetic evidence and temporary stores. Native Electron/live paint and end-to-end latency remain unmeasured here; the real-bank benchmark above supplies the transport selection evidence. The mandatory Chromium integration test can abort before renderer startup in this sandbox; it remains enabled and any such failure must be reported separately.

### Original implementation results (before the corrections above)

- Interview runner: **406 passed, 1 failed across 30 suites**. All 41 new tests pass (20 matcher/transport, 11 controller, 6 grounding, 4 section-rendering). The sole failure is the mandatory Chromium test aborting at browser launch with `SIGABRT`/process-control `EPERM`, before renderer startup. Log: `/tmp/interview-ai-verified-suites.log`.
- **`npm run lint` passes**, as does `git diff --check`. Lint log: `/tmp/interview-ai-verified-lint.log`.
- Related bridge policy, transport, privacy, task-registry and seam checks: **760 passed, 0 failed**, combining the isolated bridge run with the policy/task-registry rechecks after task registration. Logs: `/tmp/interview-bridge-vocabulary-tests.log`, `/tmp/interview-bridge-policy-recheck.log`, `/tmp/interview-task-registry-recheck.log`.
- `npm run test:unit` was attempted. Existing `local-ai-application.js` and `application-authority-ledger-store.js` tests fail when Darwin process identity invokes `/bin/ps`; the sandbox returns `spawn EPERM` / `spawnSync /bin/ps EPERM`, and the runner exits before its final summary. Log: `/tmp/interview-ai-full.log`. The user-reported full-suite green baseline therefore cannot be independently certified in this host. No process-identity checks or browser tests were weakened or skipped to manufacture a green result.

All existing working-tree changes are retained. `scripts/interview-match-*.mjs` was not edited. No app/Electron process, live provider call, commit, private application-directory access or Job Search-directory access was performed.

### Correction verification (2026-10-30)

All five corrections above have regression coverage. Added 14 tests: five matcher/transport tests, four direct-selection controller tests, one child-preload test, and four picker interaction tests. Existing section rendering/copy coverage now asserts that an empty optional block is omitted and the cited example remains in section A. Existing prepared-button coverage asserts direct ID forwarding; likely-question suggestions without saved cards retain semantic submission. The picker suite is registered in the main unit runner.

- Interview suites: **420 passed, 1 failed across 31 suites**. The only failure is the mandatory Chromium integration test: the sandbox aborts the browser during launch (`SIGABRT`, process-control `EPERM`), before renderer startup. Native compact layout, paint timing and real click latency remain unverified. Log: `/tmp/interview-matching-fixes-suites.log`.
- **`npm run lint` passes**. Log: `/tmp/interview-matching-fixes-lint.log`.
- **`git diff --check` passes**.

All prior working-tree changes remain. No benchmark script was edited, no app/Electron or live provider was run, no prohibited private directory was accessed, and no commit was made. The interview runner used Electron stubs, synthetic temporary stores and an isolated renderer-only Chromium launch attempt.

### Benchmark defaults and IPC lifecycle verification (2026-10-30)

At this earlier checkpoint, the live defaults used the stage-1 warm Sonnet/default-effort result, with cold Sonnet and then labelled Approximate matching. The cross-stage Opus decision above supersedes that selection; the existing defaults and cold-retry regressions now assert Opus. Six matcher regressions cover production defaults and alternate-provider settings, failed initialization/question retries, failure of both Claude routes, successful abstention, fallback deadlines/cancellation, and awaited fallback cleanup. Existing controller/render tests enforce the normal initial layout and automatic-only Keep going.

Startup's listener warning came from concurrent IPC invokes: each invocation already removed its lifecycle listeners on settlement, but many simultaneous calls still exceeded the WebContents listener limit. `electron/ipc/ipcUtils.js` now shares one active lifecycle dispatcher per sender and detaches it after the final invocation settles. Two regressions in the already registered `electron-regressions.js` suite check 100 sequential success/validation-failure invokes and 64 concurrent generic/manual/MCP invokes, including sender isolation and distinct navigation/crash/destruction policies. All eight new tests are in existing registered arrays; registry validation confirms all 290 suites are registered.

- Final interview run: **426 passed, 1 failed across 31 suites**. The only failure is the required isolated Chromium integration test: the sandbox aborts browser launch with `SIGABRT`/`EPERM`, before renderer startup. Log: `/tmp/interview-defaults-final-suites.log`.
- IPC suites: **155 passed, 0 failed** (`electron-regressions.js`, `solve-ipc-failure.js`, `handoff-bridge-ipc.js`). Non-api-ai suites: **160 passed, 0 failed** across all five `non-api-ai*.js` groups. No listener warning occurred. Log: `/tmp/interview-defaults-ipc-non-api.log`.
- **`npm run lint` and `git diff --check` pass**. Lint log: `/tmp/interview-defaults-lint.log`.

All existing uncommitted work is retained. No `scripts/interview-match-*.mjs` file was edited, no app/Electron or live provider was launched, no protected app-data or Job Search directory was accessed, and no commit was made.

### Opus default and compact layout verification (2026-10-30)

The live default and cold recovery route now both use Opus/default effort, retaining the shared 2500 ms question deadline. Existing matcher regressions assert both route settings; the fake CLI integration also checks `--model opus` and omission of `--effort` on the warm process and cold retries. Renderer regressions enforce section A before the layout/audio/picker tools, the optional extension's collapsed state and reset, and uninterrupted listening across the question-to-answer transition. The Chromium fit assertion and benchmark scripts are unchanged.

- Interview suites: **426 passed, 1 failed across 31 suites**. The sole failure is the mandatory Chromium integration test aborting during browser launch (`SIGABRT`, process-control `EPERM`), before renderer startup. It could not reach the compact fit assertion, so actual 420×640 geometry still requires the outside-sandbox Chromium run. Log: `/tmp/interview-opus-compact-suites.log`.
- **`npm run lint` passes**. Log: `/tmp/interview-opus-compact-lint.log`.
- **`git diff --check` passes**. The four focused renderer suites also pass **40/40** tests.

All prior working-tree changes remain. No app/Electron or live provider was run, no prohibited private directory was accessed, and no commit was made. Testing used Electron stubs, synthetic temporary stores and the isolated renderer-only Chromium launch attempt.

## Verify real generation before app Prepare

The plain-Node harness exercises the production Prepare handoffs, sparse repairs, entailment, sealing and reload without launching the app or Electron. Its **codex** transport generates fresh worker replies; `replay` checks recorded replies and cannot establish live generation quality. Run from the repository root with the same pinned snapshot, canonical job URL and applied-job bundle as the prior probe, but a **fresh** `--out`. The exact private input arguments belong in the Claude handoff rather than tracked documentation:

```bash
node --import ./scripts/test-stubs/register.mjs scripts/interview-live-prepare-harness.mjs \
  --user-data "<existing user-data root>" \
  --snapshot-id <same approved snapshot ID> \
  --job-url "<same canonical job URL>" \
  --bundle-dir "<same applied-job bundle directory>" \
  --out /tmp/interview-live-prep-v7-extensions \
  --transport codex
```

Inspect the private output's `report.json`, `final-answer-bank.json` and validation records before re-running Prepare in the app. Confirm that surviving cards carry 2–4 short additional points where evidence supports them, correct project/role hooks, complete exact citations and retained candor qualifications; inspect any card with zero points and the rejection reasons. The harness creates private output directories/files and protects its input trees against writes. This implementation session ran only synthetic/offline validation; a new successful live generation is still required to verify the real worker's yield. Do not copy private bank contents, source text or generated answers into the repo.

### Dedicated extension redesign verification (2026-10-30)

- Final interview runner: **434 passed, 1 failed across 31 suites**. The only failure is the mandatory isolated Chromium integration test aborting during browser launch (`SIGABRT`, process-control `EPERM`), before renderer startup. No browser assertion was disabled or weakened. Log: `/tmp/interview-extensions-final-suites.log`.
- **`npm run lint` passes**. Log: `/tmp/interview-extensions-final-lint.log`. **`git diff --check` passes**.
- Synthetic realistic v5 replay retains **10 safe cards, each with at least two independently cited extensions**, through the existing sparse repairs and degradation. Harness replay retains **12 cards with two points each**, drops an invented optional metric independently, and preserves its seven handoffs and unchanged input fingerprints. The wire fixtures exercise compact extension IDs and host reconstruction of full quotes.
- Registered regression coverage includes invented facts/entities/numbers, duplicated memorized bullets and optional points, inherited/shared/team-chosen/supporting-only candor, research agency, individual mechanical and semantic drops, safe-sibling preservation, extension-only evidence, sealed tampering, ID-bound semantic reviews, 180-claim coverage, collapsed section B, exact-source hooks, warm context sent once and Copy answer placement. Tests were added to existing registered suite arrays; all **290 suite files** are registered without duplicate or missing entries.

All pre-existing working-tree changes remain. No app/Electron or live provider was launched, no prohibited application-data or Job Search directory was accessed, no private bank was copied into the repo, and no commit was made. Real generation remains for Claude's codex harness verification with the exact private arguments supplied in the handoff.


### Speculative replay measurements (2026-10-30, real Opus, 81 labelled turns, 2.6 words/s, 1050 ms endpoint silence)

`scripts/interview-speculative-replay.mjs --pool 3,4`; quiet machine vs every CPU core saturated (`yes` × ncpu). Lead and lock are measured from the interviewer's last word.

| Pool | Load | Correct preview before last word | Lead median / p10 | Any wrong preview | Lock after last word median / p90 | Lock correct |
| --- | --- | --- | --- | --- | --- | --- |
| 3 | quiet | 80% | 1.52 s / 0.43 s | 0% | 1.05 s / 1.83 s | 97.5% |
| 4 | quiet | 86% | 1.78 s / 0.29 s | 0% | 1.05 s / 1.81 s | 97.5% |
| 3 | saturated | 83% | 1.49 s / 0.47 s | 1.2% | 1.05 s / 1.85 s | 97.5% |
| 4 | saturated | 83% | 1.70 s / 0.63 s | 1.2% | 1.05 s / 1.83 s | 97.5% |

Default 4: +0.2–0.27 s lead over 3 in both conditions at equal accuracy. Earlier, pool 2 showed 66% early previews (1.0 s median lead). About 88% of locks reuse a speculative result (instant or in-flight), so the median lock equals the endpoint silence. The two wrong locks are multi-part questions where either card is defensible.
