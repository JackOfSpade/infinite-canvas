# Interview Helper practice mode

The Interview Helper is the hub: career data, the application, Prepare, the
Q&A bank. A practice interview is a real virtual call with a Claude chat as
the interviewer. The app sets the call up, the chat runs it, and written
feedback about the whole call comes back to the hub.

## Flow

1. **Prepare** plans a realistic question order over every Foundation and
   company question (an AI call, stage `qa-brief`) and saves it with the
   company Q&A store (`practice.order`). Nothing is recorded or spoken by
   the app any more.
2. **Start practice interview** (hub panel) arms a one-shot session code
   (`PRACTICE-…`, 20 characters, only its SHA-256 is stored), builds the
   starter and opens `https://claude.ai/new` in the person's Chrome through
   JXA (`electron/ipc/interviewPracticeLauncher.js`). The starter is placed
   in the composer with `execCommand('insertText')`; the app never sends it.
   The person picks a model, presses Enter, switches to voice mode and treats
   it like a call. The live interview window and Listen work as on a real
   call because the chat's voice is system audio.
3. **The starter** (`buildPracticeInterviewPrompt`) carries the company and
   role context from the sealed brief (summary, themes, company facts, recent
   context) and the plan: every question with its prepared answer. It asks
   the chat to open like a real interviewer (greeting, small talk, how the
   conversation will run), to represent the company and volunteer context
   the person may interject on, to reword every planned question, and to
   decide the rest on the spot (follow-ups, curveballs, tangents) with no
   template. Nothing beyond the natural opening and the rewording is
   mandated.
4. **When the call is closed**, the chat calls `finish_practice_interview`
   on the practice connector with the session code and the feedback: overall
   score and summary, one entry per planned question (asked, how it was
   reworded, coverage of the prepared answer, adaptation, what to practice),
   unplanned moments (small talk, curveballs, off-topic, follow-ups, the
   person's questions, closing), communication notes, priorities and the
   transcript. The feedback is validated and bounded
   (`validatePracticeFeedback`), stored under the helper with the last ten
   earlier runs as history, and shown in the hub, never spoken.

## The practice connector

`/practice/mcp` on the handoff bridge's public hostname
(`electron/ipc/handoffBridge/practiceMcp.js`), routed before the OAuth
request handler in `handoffBridge/index.js`. It is added once in claude.ai
(Settings → Connectors → Add custom connector, no OAuth) as
"Infinite Canvas Practice"; the hub panel shows the URL with a Copy button.

Why it is separate from `/mcp`: the OAuth bridge is pinned to the ChatGPT
client (CIMD client id, `private_key_jwt`, OpenAI egress ranges), which a
Claude chat cannot satisfy. The practice endpoint exposes nothing to read.
Its tools are `check_practice_interview` (is this code armed?) and
`finish_practice_interview` (store feedback once). The session code is the
capability: it is high-entropy, one-shot, expires after three hours and is
cancelled when the person cancels. Everything else is bounded: POST JSON
only, public-host check, 512 KB body cap, 15 s read timeout, 30 requests
per source with 1 refill every 2 s, four in flight. No batches, no SSE.

The bridge must be on (hostname set, serving live) for practice to start;
the panel says so otherwise.

## Measurements (2026-10-30)

The one AI call the app makes for practice is the interview-order plan at
Prepare time. Ten questions, two runs per configuration, cold Claude CLI
calls (`scripts/interview-match-transports.mjs` adapters), Codex CLI through
the same adapter. "Arc score" counts four shape checks: introduction first,
motivation in the first three, closing question last, the five-year question
in the last four.

| Config | Median | Range | Valid plans | Arc score (0–4) |
|---|---|---|---|---|
| Claude opus / default | 1.66 s | 1.62–1.66 s | 2/2 | 4.0 |
| Claude opus / high | 1.62 s | 1.54–1.62 s | 2/2 | 4.0 |
| Claude opus / low | 1.65 s | 1.57–1.65 s | 2/2 | 4.0 |
| Claude sonnet / default | 1.93 s | 1.84–1.93 s | 2/2 | 4.0 |
| Claude sonnet / high | 1.91 s | 1.79–1.91 s | 2/2 | 4.0 |
| Claude haiku / default | 2.56 s | 2.55–2.56 s | 2/2 | 4.0 |
| Codex gpt-6.1-sol / low, medium; gpt-6.1-terra / low | — | — | 0/2 each | usage limit refused every call (reset Nov 4, 2026) |

Decision: keep the `qa-brief` profile (Opus, high) for the plan. Effort makes
no measurable difference on this call and every Claude model produced a
valid, well-shaped order; Opus is also the fastest here. The bridged ChatGPT
chat was not re-measured: it was already unusable for anything latency-bound
(45 s or more per handoff, see docs/interview-live-ai-matching.md), and this
call is not on the live path. The live path during a practice call is the
Listen matcher, whose model, effort and transport measurements are in that
document.

The two-section display: the live window shows the memorized answer and a
collapsed optional extension for every matched question during practice, as
on a real call. The feedback report mirrors it per planned question: a
"Memorized answer" section (coverage, adaptation, what to practice) and an
"Optional extension" details block with what could have been added beyond
the memorized answer, marked as something to say only with a real example.

## Live verification (2026-10-30, Discord · Software Engineer, Consumer Revenue)

Run on the rebuilt app with the real bridge hostname, driven as the candidate
in a text chat (voice mode not used):

- Prepare on the new build filled the stores: 4 Foundation answers, 22 company
  cards (18 disclosed coding/design questions as needs-prep), a 26-question
  order. The run took about 30 minutes end to end.
- Start practice armed a session, opened claude.ai in Chrome with the
  12k-character starter in the composer (1.8 s), and the node switched to
  "Interview in progress · waiting for feedback".
- The interviewer (Sonnet 5.5, the person's default) opened with an audio
  check and small talk, explained the format, asked for the background,
  dug into the career move, reworded "Why this company", posed an unplanned
  paid-perk tension question, answered a question about how the squad picks
  work, and pushed back with a mobile API versioning curveball. No planned
  question was read verbatim.
- The live window matched a reworded intro question to the right card and
  showed the memorized answer first, "Optional extension" collapsed beneath.
- Without the connector the chat stopped, kept the code and asked for the
  connector, as the starter instructs. The feedback it wrote was posted to
  `/practice/mcp` through the public tunnel with curl (the same request the
  connector makes): two rejections with precise notes (overall shape, moment
  kind), then accepted; a repeat was reported as duplicate; the node showed
  Overall 8/10, priorities, and the planned questions weakest first with
  memorized-answer and optional-extension sections.

Changes from the runs: the plan is presented as a pool to sample for one
45–60 minute call; coding/design items are talked through; a score on an
unasked question is dropped; the launch notice clears when feedback lands.
A third run on the rebuilt app confirmed all three live (the interviewer
framed "about 45 minutes… problems we can just talk through, no typing").
A fourth run on the next build confirmed two later fixes live (the
interviewer closed with "No worries at all, things come up… have a good
Halloween!" and "Bye for now!", with no mention of feedback or the app; the
launch placed the starter first time): the interviewer must
close the call in character and never mention the tool, the feedback or the
app after delivering (Jack heard "your feedback is saved in Infinite Canvas"
and rightly called it unnatural; the accepted note now says the same), and
the launcher retries the insert while the composer is still empty (one
launch failed with insert_mismatch 1.4 s after the tab opened, before
ProseMirror had attached).
Connector path verified afterwards: with "Infinite Canvas Practice" added in
claude.ai (No sign-in), a second session ended with the chat calling
`finish_practice_interview` itself ("Your feedback is saved in Infinite
Canvas"); the node showed the new 5/10 report and moved the earlier 8/10 run
into Earlier feedback. Still unverified: voice mode's ability to call tools
(the starter's switch-to-text fallback covers it).

## Model policy

Every Claude call in the app names a model family alias, never a dated id:
`CLAUDE_OPUS_MODEL = 'opus'` and `CLAUDE_SONNET_MODEL = 'sonnet'` in
`electron/ipc/careerWritingCore.js`. The Claude CLI resolves an alias to the
newest model of that family, and `claudeApplicationRunner.js` checks the
resolved id's family after each run. Each stage's model and effort is an
explicit choice in `CAREER_WRITING_STAGE_PROFILES`:

| Stage | Model / effort | Why |
|---|---|---|
| `qa-research` (web research for the brief) | Opus / high | Judgement over sources; web tools allowed only here. |
| `qa-brief` (brief, disclosure mapping, practice order) | Opus / high | The application `pick` profile: choosing and structuring, not drafting. Order planning measured: effort makes no difference, Opus fastest. |
| `qa-write` (spoken answers) | Opus / xhigh | The application `write` profile: the writing quality stage. |
| `qa-fact-check` / `qa-fact-correction` / `qa-fact-recheck` | Sonnet / high | The application fact profiles: rule-following verification, shared code and prompts. |
| Live matcher (Listen) | Opus / default, warm, pool of 4 | Measured in docs/interview-live-ai-matching.md: fastest configuration whose quality stops improving, also under load. |
| Practice interviewer | Chosen by the person in claude.ai | The starter is placed in the composer; the model picker is theirs. |

## Files

- `electron/ipc/interviewQaPractice.js`: order planning, code, starter,
  feedback schema and validation.
- `electron/ipc/interviewPracticeRegistry.js`: armed sessions, finish, status,
  renderer notices (`interview-practice:updated`).
- `electron/ipc/interviewPracticeLauncher.js`: the Chrome launcher.
- `electron/ipc/handoffBridge/practiceMcp.js`: the connector endpoint.
- `electron/ipc/interviewPreparation.js`: IPC `load-interview-practice`,
  `start-interview-practice`, `cancel-interview-practice`.
- `src/components/InterviewPracticePanel.jsx`: the hub panel and feedback view.
- Tests: `scripts/tests/interview-practice.js`.
