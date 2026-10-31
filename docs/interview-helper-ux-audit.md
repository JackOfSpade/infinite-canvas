# Interview Helper live-use audit

Live selection update (2026-10-30): [AI matching and two-section recall display](interview-live-ai-matching.md) now supersedes the lexical-only live-flow descriptions below. The separate benchmark is still the authority for choosing transport/model/effort defaults; no benchmark scripts were changed.

Date: 2026-10-30. Baseline means the code present at the start of this task; implementation changes are recorded separately below. File line numbers in the baseline trace refer to that initial code and may move in the accompanying change.

Latest update: prepared cards now use mechanically checked spoken paraphrases and a secondary entailment review. The final section below supersedes the earlier literal-only prepared-answer limitations; exact fallback cues and research provenance retain their existing contracts.

## Scope and evidence

This is an offline source, fixture and synthetic-performance audit. The real Electron application was not quit, relaunched, built, packaged or used for a live interview experiment. Neither the app's private data directory nor `~/Desktop/Job Search` was accessed. No external model/bridge calls were made. The ongoing official-posting refresh and unrelated working-tree edits were left alone.

This task changes Interview Helper rather than application generation. The application-improvement playbook was read for scope; its private generator counter was not inspected because the user's explicit prohibition covers that private directory. No application-generator improvement session, counter reset or change to generator truth checks is implied by this audit.

The target is useful material within about **5 seconds** and the complete answer within about **15 seconds** of submitting a question. Source inspection can identify blocking work and missing states; it cannot prove the running app meets either target under refresh contention. No interview-specific time-to-first-text telemetry was found in the checked-in interview tests/fixtures. Tests contain synthetic content, not timing observations from an actual interview.

## Main finding

**The baseline live question path already makes zero AI calls.** It constructs a deterministic rail of literal saved career evidence. Prepare uses two serial ChatGPT bridge handoffs, but those handoffs are not repeated for each question. Adding a live bridge fallback would introduce a latency dependency that cannot reliably meet the target.

Retrieval itself is fast in the synthetic measurements below. The greatest practical problem is whether the material is a usable answer while talking: the rail can contain irrelevant role context, repeat lengthy cues, omit the question's anchor, or offer no matching evidence. It does not synthesize a spoken answer, and the live matcher does not use the job or application to choose the career example.

## Ranked issues

| Rank | Impact during a live interview | Baseline issue | Appropriate action |
| --- | --- | --- | --- |
| 1 | Critical: evidence appears quickly but may not answer the question | Live retrieval reads career evidence only. Job themes and submitted résumé/letter positioning are a separate collapsed reference. A truthful career fact is not proof it is consistent with what was submitted. | Put prepared likely questions, role context and exact application points within immediate reach; preserve the distinction between career proof and submitted wording. Do not relabel a string match as factual reconciliation. |
| 2 | High: common follow-ups lose the story or useful input is dropped | The last-question extractor intentionally ignores previous independent questions. A dependent follow-up can lack discriminating terms; multipart prompts can lose earlier parts. There is no child-session story anchor for a separately submitted follow-up. | Preserve an explicitly selected story for tightly recognized dependent follow-ups, disclose missing components, and test that independent questions cannot inherit unrelated evidence. |
| 3 | High: interaction competes with listening and speaking | A textarea requires button/Tab submission; Enter adds a newline. Initial autofocus exists but focus is not deliberately restored after async load, question advance or failure. No pending/duplicate-submit state, copy control or quick prepared-question selection. | Enter to submit, Shift+Enter newline, explicit focus management, synchronous duplicate guard, visible pending state, copy with feedback, quick prepared prompts. |
| 4 | High: main-thread work can delay all questions during another long task | Every live submit reopens and validates the complete pinned snapshot, then checks/hashes the full prepared brief. No live lookup deadline. Snapshot files up to 64 MiB are compatible. | Keep validation authoritative. Precompute reusable prepared material outside the live submit path; profile before adopting a validation cache, and make any frozen-session semantics explicit. |
| 5 | High: the wrong cue can look like a ready answer | Lexical threshold plus narrow morphology/concepts is conservative but brittle to typos, paraphrases and general questions. A direct skill or role title can pass without a concrete behavioral story. Missing-component detection is a wording heuristic. | Keep unsupported truthful; add only tested, narrow intent handling. Label the material as exact cues, expose gaps, and avoid unsupported rewrites or invented STAR details. |
| 6 | Medium/high: scanning and scrolling cost seconds | Up to six complete cues appear in the rail, followed by a second copy of the active cue. Long exact fields can be 12,000 characters. The active card follows the full rail and the header gives no job identity. | Lead with a concise topic/attribution and immediately visible evidence. Reduce duplicate prose, retain complete source strings in a readable expandable/scrollable path, and keep controls accessible. |
| 7 | Medium/high: preparation failure is opaque when time is short | Generic safe failure text does not distinguish bridge unavailable, waiting for a worker, validation correction or interrupted preparation. Prepare invalidates the visible ready brief before a replacement succeeds. | Explain where to recover (AI handoff dock/worker connection), distinguish preparation from local live lookup, and retain safe recoverability. Do not echo private paths/provider text. |
| 8 | Medium: sealed data can be valid but old | URL/snapshot/artifact bindings reject changed selections, but frozen captured artifacts do not observe later edits in the source application folder. Reusing the same URL does not detect a changed live job. Research has no expiry. | Display preparation date and frozen-source meaning; keep explicit reselect/reprepare actions. A newer career snapshot notice already exists. Avoid unsolicited web refresh during the live interview. |

## Baseline latency trace

### Question submit to visible evidence

1. `src/interview-window/InterviewWindowApp.jsx:75`: form submission prevents navigation, clears error and awaits `window.interviewAPI.submitQuestion(question)`. The UI has no submitting state. The old supported rail is deliberately locked until Next question.
2. `electron/interviewWindowPreload.js:5`: checks string type and maximum 2,000 characters, then invokes `interview-window:submit-question`. This restricted preload exposes no general filesystem or AI access.
3. `electron/interviewWindow.js:538`: resolves the child-owned main session, rejects invalid/empty questions and returns an existing supported locked display without replacement. A question-sequence fence prevents a late lookup overwriting a newer question or parent relaunch.
4. `electron/interviewWindow.js:550`: awaits `loadSnapshot` on **every unlocked question**.
5. `electron/ipc/interviewHelper.js:184`: calls `readPinnedCareerSnapshot` and projects approved fields into a restricted career profile. Raw career sources, contacts and segments do not cross this projection.
6. `electron/ipc/careerSnapshot.js:5559`: resolves trusted directories, checks file metadata and identity, reads the snapshot, verifies post-read metadata, parses JSON, and validates the full snapshot. Directory handling also enforces private modes. File operations await asynchronously; `JSON.parse` and the validation below run synchronously on Electron's main thread.
7. `electron/ipc/careerSnapshot.js:5341`: current-contract validation canonically serializes the snapshot, rebuilds the source corpus and hashes/segments, compares canonical source/segment records, validates the complete career profile, page plan, reconciliation receipt and six-audit history. The compatible immutable snapshot limit is **64 MiB**. Historical pinned contracts also undergo corpus, profile and version-appropriate receipt validation. This is substantial repeated trust work, not merely a small JSON read.
8. `src/utils/interviewHelper.js:549`: `buildInterviewPlan` extracts the current question, analyzes terms/asked components, re-extracts profile evidence, scores literal terms/phrases and narrowly controlled concepts, sorts candidates, then chooses a coherent role/entity path of at most six exact strings. It builds **no AI prompt** and performs **no network request**. A generic overview/accomplishment intent can select source-order evidence, with a warning that this is not a best/most-recent ranking.
9. `electron/interviewWindow.js:231`: `projectInterviewDisplay` rechecks the complete prepared brief through `isInterviewBrief` (`:167`) and validates the plan grammar. Brief validation checks field bounds, source URL hashes, source consistency and a SHA-256 of stable semantic JSON. It emits bounded display fields and strips career provenance/profile objects.
10. Main sends `interview-window:brief-updated` and returns the same display in the invoke result. The React subscription and submit handler both apply it. React renders the entire rail and active cue. Receiving the event and invoke result is duplicate state delivery, not two AI round trips.

**Per live question:** zero prompt characters/tokens; zero AI round trips; one submit IPC invoke plus an update event; one complete snapshot read/validation for an unlocked lookup; one complete brief validation; deterministic CPU retrieval; one complete display result. Unsupported questions also project/check the brief.

There is **no token streaming**: first evidence and the complete rail become available together. There is **no live deadline or retry loop**. Loader failures are mapped to fixed messages. An unresolved filesystem operation/IPC response can leave the user waiting; main-thread contention delays IPC handling and rendering independently of retrieval speed. Window launch similarly awaits verification and native navigation; there is no promise-level deadline for an alive window whose initial navigation never settles.

### Prepare and AI transport, separately

`src/nodes/InterviewHelperNode.jsx:616` starts a recoverable preparation run and calls `prepareInterviewBrief`. `electron/preload.js:162` maps that to `build-interview-brief`; `electron/ipc/interviewPreparation.js:902` validates the arguments and runs `buildInterviewBrief` (`:852`). It loads/revalidates the private captured application artifact, then makes **two serial AI handoffs**:

1. `interview-brief-research`: canonical job URL, captured original listing and application target. Requests source URLs/quotes and explicitly forbids candidate/career claims.
2. `interview-brief-assessment`: raw research, original listing, target and captured résumé/cover-letter positioning. Produces a schema-backed brief. Literal research and document provenance is checked before accepting/sealing the result.

`electron/ipc/llm.js:417,458` routes these calls into `requestNonApiAi` in `electron/ipc/nonApiAi.js`. The transport materializes instructions/schema and output guidance, computes durable identity, loads/writes durable state, then registers a pending handoff. Both interview tasks are allowlisted for the bridge (`nonApiAi.js:3443`); research is one of the narrowly reviewed schema-less grounded tasks (`:3421`). An unavailable bridge remains a connection/setup state; it is not a reason to add an alternate live-answer path.

A consenting bridge worker retrieves the handoff, performs external chat research/generation and submits the **complete response**. The common submit path verifies the handoff identity, parses/validates JSON when required, runs the caller's provenance validator, writes durable acceptance and resolves the caller. Assessment is validated again, sealed in the app-owned content-addressed prepared-brief store, and only then returned to the renderer. Accepted durable steps can replay on resume; an unfinished/invalid step needs another response. No partial output is rendered as an approved brief.

Timing/retry controls belong to this preparatory transport, **not** to a live question:

| Control | Value/meaning |
| --- | --- |
| Overall `requestNonApiAi` completion | No overall generation deadline; pending promise waits for accepted response, cancellation or terminal failure. |
| Bridge GET hold / total budget | 20 s / 25 s; tool transport budgets, not a completed-answer guarantee. |
| Bridge submit response / tool deadline | 25 s / 28 s; a response can report work still in flight. |
| Stuck submit / chat presentation watchdog | 90 s. |
| Pool idle waiting polls | 15–20 s, in addition to generation/research time. |
| Validation retry pacing | Starts at 750 ms, backs off exponentially to 30 s. Changing failures can continue without a fixed round limit. |
| Same validator-rule rejection | Five failures escalate the request to manual recovery. |
| Worker replacement safety cap | Three automatic replacements for an unanswered handoff. |
| HTTP request/body controls | Separate request/body timeouts protect transport resources; they are not preparation SLAs. |

Sources: `electron/ipc/nonApiAi.js:60–76,3029,3338`; `electron/ipc/handoffBridge/constants.js`; `electron/ipc/handoffBridge/engine.js`; `electron/ipc/handoffBridge/sources/push.js`.

### Offline measurements and interpretation

Measured on this workspace with Node and the repository's Electron test stub; all content synthetic. After ten warm-up calls, 100 calls to `buildInterviewPlan` were timed with `performance.now()` and sorted. Each profile had one role and 10/100/1,000 similarly sized literal achievements; the question was a discriminating onboarding/conversion query.

| Achievement count | Profile JSON characters | Retrieval p50 | Retrieval p95 | Maximum observed |
| ---: | ---: | ---: | ---: | ---: |
| 10 | 1,746 | 0.104 ms | 0.159 ms | 1.743 ms |
| 100 | 15,336 | 0.624 ms | 0.806 ms | 0.987 ms |
| 1,000 | 153,036 | 6.284 ms | 6.653 ms | 6.899 ms |

These measurements exclude disk reads, full snapshot validation, Electron scheduling/IPC, React render/paint and competition from the official-posting refresh. They are not end-to-end latency or a production percentile.

Prompts were captured by injecting a synthetic `loadBundle`, `callRaw` and `callText` into `buildInterviewBrief`; the second caller stopped after capture. Approximate tokens use the requested **ceiling(characters / 4)**, independent of the transport's own informational estimator. Materialized counts include `materializeNonApiPrompt`, assessment schema/copy suffix, representative handoff code `IH01`, and output caps 6,144/4,096. Actual runtime handoff settings, code length and formula-seed metadata add a small variable amount.

| Synthetic listing / résumé / research characters | Research base chars / tokens | Assessment base chars / tokens | Research materialized chars / tokens | Assessment materialized chars / tokens |
| --- | ---: | ---: | ---: | ---: |
| 46 / 73 / 73 | 2,663 / 666 | 4,860 / 1,215 | 3,425 / 857 | 13,230 / 3,308 |
| 8,000 / 10,000 / 8,000 | 10,617 / 2,655 | 30,668 / 7,667 | 11,379 / 2,845 | 39,038 / 9,760 |

The fixed schema/serialization instructions are a material part of assessment size. The assessment also repeats the listing and includes research/application prose. These are synthetic sizing examples, not a claim about the user's actual prompt sizes.

**Estimated baseline time to useful text:** ordinary local retrieval should fit comfortably inside five seconds for a normal profile, assuming the main thread is available. This is an inference from the local architecture and CPU timings, not an observed UI measurement. There is no demonstrated upper bound while a large snapshot is validated or the main thread is busy. The complete evidence rail arrives at the same time as the first cue and should ordinarily fit inside 15 seconds. The baseline cannot promise a complete spoken answer: it returns exact evidence cues, and questions requiring synthesis or unmatched evidence remain unsupported. Prepare's two serial externally scheduled handoffs cannot reliably satisfy either live target and must finish beforehand.

### Reproducing the synthetic measurement

The following uses only dependency-injected data and in-process test stubs; it neither starts Electron nor reads the private stores. Run from the repository root. Timings vary by machine/load; the earlier table records the initial audit run.

```bash
node --import ./scripts/test-stubs/register.mjs --input-type=module <<'EOF'
import { performance } from 'node:perf_hooks';
import { buildInterviewBrief } from './electron/ipc/interviewPreparation.js';
import { materializeNonApiPrompt } from './electron/ipc/nonApiAi.js';
import { buildInterviewPlan } from './src/utils/interviewHelper.js';
for (const [listingSize, resumeSize, researchSize] of [[46,73,73],[8000,10000,8000]]) {
  const bundle = {
    job: { title:'Product Manager', company:'Acme', location:'Toronto' },
    listingText:'Acme seeks a product leader. '.repeat(Math.ceil(listingSize/28)).slice(0,listingSize),
    applicationPositioning: {
      resume:'Candidate led delivery. '.repeat(Math.ceil(resumeSize/24)).slice(0,resumeSize),
      coverLetter:'Build reliable systems.',
    },
    digests: { applicationHtmlSha256:'a'.repeat(64) },
  };
  const prompts = [];
  await buildInterviewBrief({
    nodeId:'node-1', snapshotId:'a'.repeat(64),
    canonicalJobUrl:'https://jobs.example.test/1', bundleArtifactId:'e'.repeat(64),
    manualAiRunId:'run-1', loadBundle:async()=>bundle,
    callRaw:async(prompt,opts)=>{
      prompts.push({prompt,opts});
      return 'Acme serves teams. '.repeat(Math.ceil(researchSize/19)).slice(0,researchSize);
    },
    callText:async(prompt,opts)=>{prompts.push({prompt,opts});throw new Error('captured');},
  }).catch(()=>{});
  console.log(JSON.stringify({input:{listingSize,resumeSize,researchSize},
    prompts:prompts.map(({prompt,opts})=>{
      const full=materializeNonApiPrompt({prompt,...opts,
        requestKind:opts.responseSchema?'structured-text':'raw-text',
        maxOutputTokens:opts.responseSchema?4096:6144,handoffCode:'IH01'});
      return {task:opts.task,baseChars:prompt.length,baseTokens:Math.ceil(prompt.length/4),
        materializedChars:full.length,materializedTokens:Math.ceil(full.length/4)};
    })}));
}
for (const count of [10,100,1000]) {
  const profile={snapshotId:'a'.repeat(64),profile:{
    roles:[{id:'r1',title:'Product Manager',employer:'Acme'}],
    achievements:Array.from({length:count},(_,i)=>({id:`a${i}`,roleId:'r1',
      claim:`Improved onboarding conversion through a simpler setup flow for product ${i}.`,
      evidenceSegmentIds:['segment-0001']})),
    projects:[],skills:[],education:[],certifications:[],otherEvidence:[],
  }};
  const question='Tell me about improving onboarding conversion.';
  for(let i=0;i<10;i++)buildInterviewPlan({question,profile});
  const ms=[];
  for(let i=0;i<100;i++){
    const start=performance.now();buildInterviewPlan({question,profile});
    ms.push(performance.now()-start);
  }
  ms.sort((a,b)=>a-b);
  console.log(JSON.stringify({count,profileChars:JSON.stringify(profile).length,
    p50:ms[50],p95:ms[95],max:ms.at(-1)}));
}
EOF
```

## Accuracy and grounding

The career snapshot is the authority for career claims. Live cues equal individual profile fields, retain source/entity provenance internally and are not rewritten by an LLM. Direct skills are vetted; relationship-qualified/non-indexable skills are excluded. Selected evidence stays within one coherent role/entity path rather than stitching different jobs into a story. Missing requested decision/outcome/lesson details are disclosed. Those safeguards should remain.

The brief is independently sealed and bound to the canonical URL hash, exact career snapshot ID and captured application artifact/digest. The child verifies the app-owned record rather than trusting editable canvas data. The captured application target wins over researched role identity; research can only fill genuinely missing identity fields with literal source text. Company facts and recent context must be copied literally from raw research, with literal source URL/date/quote checks. Application positioning must be literal text from its declared résumé or cover-letter source. Untrusted listing/research/application prose is wrapped as data and cannot amend career evidence.

Limits of these safeguards:

- A literal company fact copied from model-produced raw research is not independently verified against the web page. Source/date/quote provenance is useful but does not prove the research was true or current. Raw research validation primarily checks nonempty bounded text. Free-form role summary/themes/questions/warnings are not all independently exact-quote verified.
- The live plan is not checked against the submitted résumé/letter. A separately approved career snapshot can disagree with a captured old application; showing both sources does not resolve that contradiction. Do not invent a bridge between them or present submitted wording as newly verified career proof.
- The captured source folder is never reopened on artifact load (`interviewPreparation.js:472`). This makes the artifact stable but means later source edits are invisible until reselected. A valid digest is integrity, not freshness or proof that this exact folder was actually sent.
- A canonical URL binding detects a different selection; it does not detect changed content at the same URL. Research is frozen at preparation and has no automatic expiry.
- Profile-order overview/accomplishment retrieval does not establish most recent/biggest/best. A conservative match can still be too generic for the role. Lexical overlap is relevance evidence, not semantic proof that a cue answers all requested parts.
- Missing-component detection is a finite keyword heuristic on the visible strings, not a factual completeness/STAR assessment. No outcome, metric, decision or lesson may be filled in merely because an interviewer asked for it.

## Baseline UI walkthrough

| State/input | Baseline behavior and friction |
| --- | --- |
| Empty setup | Four prerequisites: approved career source/import, canonical job URL, captured application bundle, Prepare. The workflow is explicit but launch is unavailable until all preparation succeeds. |
| Preparing | Button says Preparing; run IDs allow safe resume. No stage ETA, bridge status or clear worker-busy instruction in this node. The previous ready result is hidden while replacement preparation runs. |
| Prepared | Ready card names the job, previews themes/questions/application positioning/warnings. Child shows a generic header and the reference briefing is collapsed. Likely questions are text, not a one-action rehearsal path. |
| Failed/interrupted preparation | Fixed privacy-safe errors and Resume preparation exist. They hide specific failure causes; the user must infer whether to fix bridge setup, wait, retry validation or replace inputs. |
| Bridge offline/worker busy | Prevents finishing Prepare; no live AI is needed after a prepared session opens. The baseline does not make that distinction prominent. |
| Initial child load | Shows Loading prepared brief. Missing `interviewAPI` leaves loading forever. Load rejection/null shows Retry/Close. The textarea's `autoFocus` is the only initial focus mechanism. |
| Typed question | Textarea, max 2,000 chars; Enter inserts a newline, submit requires button/Tab. Empty input is sent then rejected. No submitting state/duplicate guard. |
| Supported question | Question locks; up to six full cues plus duplicate active cue. Arrow keys advance only when focus is outside input. Previous/Next/Next question are available. The form disappears, so a typo requires clearing the rail and retyping. |
| Unsupported question | Truthful no-match state and Enter another question. The form also disappears here, adding another action before revising a typo. |
| Follow-up | Separate question after Next question has no story anchor. Generic follow-up may have no meaningful search terms. Pasted adjacent follow-ups have narrow extraction support, but separate child submissions do not preserve the story. |
| Multipart question | Latest-question extraction can drop independent earlier parts; limited dependent-part logic cannot guarantee full coverage. |
| Long answer/evidence | Exact fields up to 12,000 chars are accepted. Long cues and duplicated text require scrolling before reaching active card/controls; there is no concise answer-level headline or copy control. |
| Window controls | 440×680 default, minimum 360×480, resizable. Always-on-top opt-in exists and main restores its state after renderer reload. No explicit compact mode; briefing details can be collapsed. |
| Lookup failure | Fixed path-free messages tell the user to try again or relaunch the companion. No wait indicator, cancellation or time-bound recovery. Relaunch instructions refer to the helper window, not quitting the whole app. |

## Implementation and validation record

The following records the final implementation. Baseline findings above remain the record of the initial behavior.

### Changes shipped in this task

| Ranked issue | Final change | Files | Remaining limit |
| --- | --- | --- | --- |
| 1: application/job alignment | Prepared likely-question buttons invoke local lookup directly. Submitted wording is explicitly reference, with a reminder to check career/application alignment and replace edited bundles. Preparation now says Research ready and explains exact-cue scope. | `src/interview-window/InterviewWindowApp.jsx`, `src/nodes/InterviewHelperNode.jsx` | No semantic reconciliation or new drafted answer bank; the buttons use existing prepared questions and are not cached answers. |
| 2: dependent follow-ups/multipart | Added explicit Follow-up action through a sender-bound scalar-only IPC route. Main preserves the canonical original anchor, reloads the approved pin, rebuilds/compares the original plan, and reuses its exact steps/evidence. Requested gaps remain visible; errors preserve the prior usable answer. Expanded the finite dependent-part grammar and adjacent chain extraction. Next question clears the anchor; unrelated questions cannot borrow it. | `src/utils/interviewHelper.js`, `electron/interviewWindow.js`, `electron/interviewWindowPreload.js`, live JSX/error mapping | Strict generic follow-ups only; separate independent parts still use latest-question isolation. |
| 3: keyboard/focus pressure | Enter submits; Shift+Enter inserts a newline; IME composition/repeated keys do not submit. Same-tick duplicate guard, pending feedback, focus on open/answer/next/edit/failure, Ctrl/Cmd+Enter next question, copy with attribution/gap warnings and manual fallback. | Live JSX/CSS | No microphone/ASR or global system shortcut added. |
| 4: synchronous trust work | Preserved complete snapshot and brief checks. Added a repeatable synthetic prompt/retrieval/projection/follow-up benchmark. | `scripts/interview-helper-benchmark.mjs`; existing trust path unchanged | Main-thread contention remains; no unsafe validation bypass or artificial speedup claimed. |
| 5: typos and unsupported matches | Edit question preserves the original text, including after a supported match. Unsupported results retain/show the question, focus the edit action, and suggest specific project/skill/result terms. | Live JSX | No fuzzy matching or broadened career-match threshold. |
| 6: glanceability/long cues | Current cue appears before the full rail; grounding gaps appear before the cue. Duplicate full rail starts collapsed under All saved cues. Sticky controls, larger cue text, wrapping and visible focus improve compact use; briefing keeps normal arrow-key scrolling. | Live JSX/CSS | Source text remains exact and can be long; no generated headline or invented STAR decomposition. |
| 7: recovery/offline | Missing narrow bridge now shows Retry/Close instead of permanent loading; null submit/session loss is explicit. Follow-up errors give fixed immediate actions. Local/no-AI-wait indicator distinguishes live lookup from preparation. | Live JSX, `src/interview-window/submitError.js` | Preparation still lacks reason-specific bridge/worker/validation stage reporting; no claim that stalled IPC has a timeout. |
| 8: frozen/stale inputs | Fixed prep/live reference copy explains captured documents and career/application alignment. Kept existing explicit replacement/reprepare and pinned-snapshot behavior. | Prep/live JSX | No automatic job-page refresh or research expiry; preparation date still not surfaced. |

No validation was moved out of the live path. No renderer receives a raw profile, path or new broad capability. A new follow-up can add requested components to the question analysis but cannot add a claim, change the evidence path, or turn a missing result/lesson into an answer. The existing supported-rail submit lock remains; continuation is a separate explicit action. Independent review found no concrete grounding or race defects in the new helper/controller/preload diff.

### Tests and checks

New tests cover each behavior change:

- `scripts/tests/interview-helper.js`: two new cases cover dependent action/result/lesson chains, idempotent extraction, independent-topic/prose isolation, exact anchor reuse, bounded questions, and missing decision/lesson disclosure.
- `scripts/tests/interview-window.js`: five new cases cover restricted preload routing, sender/shape/size checks, repeated follow-ups, snapshot revalidation, unchanged/usable answer on rejection, Next/newer-request/closure races, renderer reload, and pending parent snapshot adoption only after Next.
- `scripts/tests/interview-window-render.js`: six new integration cases plus extended assertions cover Enter/newline/IME/repeat handling, duplicate prevention, loading feedback, prepared buttons, edit preservation, copy/source/gap/fallback, focus after delayed and immediately repeated failures, unsupported focus, explicit follow-up routing/recovery, missing preload/null result, collapsed rail, and warning-before-cue placement.
- `scripts/tests/interview-helper-render.js`: extended ready/failure assertions cover research scope, captured bundle/alignment reminder, source labels and preparation naming without changing the sealed brief.

Final focused result: **206 passed, 0 failed across all eight Interview Helper suites**. The synthetic benchmark runs successfully with the Electron test stub. `npm run lint` passes. `npm run test:resume-pdf` passes independently (the PDF test chain was otherwise not reached by the full test command).

**Full `npm test` was attempted and did not pass in this environment.** Unrelated `local-ai-application.js` and `application-authority-ledger-store.js` tests fail when `applicationAuthorityLedgerStore.js:344` invokes `/bin/ps` to obtain Darwin process identity: the sandbox returns `spawn EPERM` / `spawnSync /bin/ps EPERM`. The unit runner then exits before its final summary; this is not a zero-failure full-suite result. No unrelated ledger code, tests, runner, process-identity safety checks or sandbox restrictions were changed to mask it. The required full-suite zero-failure check remains outstanding in a host that permits that process inspection. Approval escalation is unavailable in this session.

Logs for this run: `/tmp/interview-helper-npm-test.log`, `/tmp/interview-helper-focused-tests.log`, `/tmp/interview-helper-lint.log`, `/tmp/interview-helper-pdf-tests.log`. No app build, restart, packaging, live bridge use or live-app test was performed; existing running code was not replaced.

### Before versus after latency

Baseline and revised implementation both use **zero live AI calls and zero live prompt tokens**. The revised path retains the full per-question snapshot checks and complete brief validation. Prepared-question buttons run through the existing local lookup; they are not precomputed answer cards or an answer cache. Their benefit is fewer input actions, not elimination of provider latency.

The standalone synthetic benchmark extends the initial measurement with display projection and the new anchored-follow-up helper. It creates/cleans an isolated temporary directory, injects every bundle/AI caller and never opens private stores or a live bridge:

```bash
node --import ./scripts/test-stubs/register.mjs scripts/interview-helper-benchmark.mjs
```

Measured after implementation, again with ten warm-ups and 100 samples per operation:

| Achievement count | Retrieval p50 / p95 | Retrieval + display projection p50 / p95 | Follow-up helper + display projection p50 / p95 | Follow-up with canonical anchor rebuild/comparison + projection p50 / p95 |
| ---: | ---: | ---: | ---: | ---: |
| 10 | 0.102 / 0.156 ms | 0.156 / 0.305 ms | 0.071 / 0.094 ms | 0.189 / 0.398 ms |
| 100 | 0.615 / 0.983 ms | 0.659 / 0.879 ms | 0.062 / 0.091 ms | 0.683 / 0.843 ms |
| 1,000 | 6.334 / 8.200 ms | 6.261 / 7.841 ms | 0.059 / 0.076 ms | 6.257 / 6.904 ms |

The cheap follow-up-helper column operates on an existing canonical anchor; it **is not the actual IPC path**. Main still reloads/verifies the pinned snapshot and rebuilds/compares the original anchor before applying a follow-up. The last column models that retrieval/comparison work; all columns still exclude snapshot reading/validation, Electron scheduling/IPC and React rendering/paint. Display projection includes the full brief hash/grammar checks against the compact synthetic brief. These figures do not measure the largest allowed brief/snapshot.

The initial retrieval p95 values were 0.159 / 0.806 / 6.653 ms; revised retrieval p95 values were 0.156 / 0.983 / 8.200 ms. These warm synthetic runs are consistent with the same local cost class, with machine/load variation; **no latency speedup is established**. Prompt sizes remain as recorded above. The practical improvement is immediate selection of prepared prompts, fewer keyboard actions and useful preservation of an already selected story. First text and complete evidence still arrive together. A normal-sized, uncongested session is still estimated to fit the 5-second/15-second targets, but no production end-to-end result is claimed and main-thread contention remains an unresolved latency risk.

### Deliberately deferred

1. **Prepared spoken answers/STAR cards and job-aware evidence choice — shipped in the follow-up below.** The original audit deferred this because research cannot receive candidate claims. The follow-up adds a separate evidence-bound answer artifact; research retains its original contract.
2. **Semantic reconciliation with the submitted résumé/letter.** A file-hash receipt and snapshot pin prove integrity, not consistency. Detecting genuine contradictions requires verified origin metadata and an explicit conflict-resolution design. The new reminder/source labels make the limit visible but do not solve it.
3. **Validation cost and real latency telemetry.** Profile full snapshot validation under representative permitted fixtures and move CPU work off the Electron main thread or introduce explicitly frozen session semantics with invalidation tests. No existing truth check was dropped to save milliseconds. Measure submit-to-first-useful-paint under concurrent refresh before claiming the target.
4. **Fuzzy/paraphrase retrieval and broad independent multipart questions.** Conservative thresholds still miss typos and general motivation questions. New semantic matches need their own false-positive evaluation; independent parts need explicit subquestions rather than stitching stories. Editing and prepared buttons are the immediate safe paths.
5. **Research verification/freshness and preparation status.** Independently check source-page facts, surface preparation date/expiry, retain the previous validated brief during safe repreparation, and expose privacy-safe bridge/busy/validation stage state. These need transport/preparation-state changes; no unrelated bridge code was changed during the ongoing refresh.
6. **Live-app visual/timing validation and full-suite completion.** The user's running refresh was preserved. Native-window paint, clipboard permissions, compact sizing and keyboard behavior were tested through DOM/controller seams only. Full `npm test` needs a permitted host process-identity check as described above.

A live generative fallback was deliberately not added: the existing two serial externally scheduled preparation calls cannot reliably satisfy a five-second first-useful-text target, and approving partial generated candidate claims before grounding would weaken the current guarantees.

## Follow-up shipped: prepared spoken answers and job-aware selection

Date: 2026-10-30. This implements deferred item 1 above. All observations remain offline, using synthetic inputs and injected transports. No real application process, career store, submitted application directory or live AI handoff was accessed. The concurrent official-posting timer implementation was preserved; `officialPostingService.js` was not edited. No build, packaging, restart or commit was performed. This is Interview Helper work, so the prohibited private application-improvement counter was not inspected.

### Preparation, truth and persistence

Prepare now completes three serial handoffs: the existing research and no-candidate brief assessment, followed by **`interview-answer-bank`**. The third step receives the sealed brief's themes/likely questions, a restricted projection of approved career achievements/projects/other evidence, and the captured résumé/letter positioning. It selects examples for the job and orders **12–20 cards**, each containing a question, matching variants, headline, 2–4 spoken points, concrete career example, statement citations and a résumé wording-coverage flag. Career evidence is never inserted into the research prompt, brief schema or persisted canvas brief.

Every headline, point and example cites exactly one stable evidence ID and its complete verbatim source field. Career IDs bind the approved snapshot, entity, field and exact text; research IDs bind the sealed brief and quoted fact/source identity. The host regenerates that projection from the approved inputs and rejects a whole bank if any citation, quotation, number, employer, title, source association or binding changes. It checks actual statement text against a deliberately small grammar: **the complete cited text, optionally preceded by “One example: ”**. Valid citations cannot license added prose. Rejection provides field-specific correction rules through the existing bridge validation/delta-reprompt mechanism; partial banks are never accepted or displayed.

This deliberately tightens the proposed design in several places:

- The host supplies 24 common question/intent families, and the worker selects 12–20. Questions and variants must come from the corresponding catalog entry. Free-form metadata could otherwise contain an uncited invented premise even when every answer point was grounded. Example choice/order remains job-aware; question wording is bounded.
- The host does not insert “I” before an action verb. A phrase such as “Built in 2022 by external contractors” must not become a claim that the candidate built it. Already first-person source wording can be used verbatim.
- STAR headings require the source itself to begin with the corresponding explicit `Situation:`, `Task:`, `Action:` or `Result:` label. Otherwise points stay unlabeled. A STAR card must cite a single career entity; a shared employer does not prove separate actions/outcomes belong to one story. Missing outcomes are never written to complete STAR.
- A true résumé flag requires a literal captured résumé quotation containing complete sentence-equivalent coverage of every career statement used. A substring inside “Never led …”, “Observed …” or another qualified sentence fails. This proves cited wording coverage, not semantic reconciliation of every claim in the document; otherwise the flag stays unconfirmed. The letter and receipt cannot establish this flag.

The private **`interview-helper-answer-banks`** store contains immutable SHA-256-addressed artifacts bound to the snapshot ID, semantic brief hash, captured application artifact ID/digest and canonical job URL hash. A separate private **`interview-helper-answer-bindings`** lookup connects the exact brief inputs to a bank. Publication validates sources again, atomically replaces the lookup on a successful explicit Prepare, and independently reloads the exact new address. Reprepare can repair a corrupt lookup and replace old cards for unchanged inputs. A missing, altered, oversized, symlinked or improperly permissioned record fails closed. These namespaces join the existing generic renderer read/write/open/delete protections.

The third handoff uses the existing node/run-scoped durable transport. Wall-clock brief publication time is omitted from its prompt; the transport's existing generated-boundary nonce canonicalization keeps resumed step identity stable. A research-only legacy brief continues to launch exact cues and offers Prepare again. The renderer receives a host-verified readiness/count summary, not bank prose, source files or a new storage capability.

### Live use

The live path still makes **zero AI calls**. It revalidates the pinned snapshot and sealed bank locally, tries a unique exact question/variant, then reuses the existing conservative lexical matcher with stricter term coverage, intent/component checks and an ambiguity margin. Changed employer/numeric anchors, weak matches and ties abstain. Prepared buttons cover all bank questions and use that same local route.

The matched card appears first: large headline, spoken points, concrete example and numbered statement citations. Each citation expands and focuses its exact source quote. Copy preserves the answer and numbered sources. Enter, Shift+Enter, duplicate-submit protection, focus recovery, Edit/Next and Cmd/Ctrl+Enter also work for a card with no lexical rail. Unmatched questions retain the clearly labeled exact-cue/unsupported view.

A job-aware prepared example may differ from the career matcher's source-order choice. The window exposes an underlying rail and same-example Follow-up only when the canonical rail and card refer to the same exact career story. Otherwise it shows the card alone; it cannot silently switch examples. A successful explicit follow-up clears the earlier authored card and displays verified cues/gaps. Locks, renderer reload, parent-update deferral and request-sequence fences remain in force.

### Files changed in this follow-up

| Area | Files |
| --- | --- |
| Answer schema, projection, validator and private artifact | `electron/ipc/interviewAnswerBank.js` (new) |
| Third preparation handoff, sealing, lookup/reload and readiness | `electron/ipc/interviewPreparation.js` |
| Local matching and child session integration | `src/utils/interviewAnswerMatching.js` (new), `electron/interviewWindow.js` |
| Prepared cards, citations, keyboard/focus and preparation copy | `src/interview-window/InterviewWindowApp.jsx`, `src/interview-window/interviewWindow.css`, `src/nodes/InterviewHelperNode.jsx` |
| Private store access guards | `electron/ipc/filesystem.js`, `electron/utils/pathSafety.js` |
| Additive task registration/output guidance/closed task vocabularies | `electron/ipc/llm.js`, `electron/ipc/nonApiAi.js`, `electron/ipc/handoffBridge/controller.js`, `electron/ipc/handoffBridge/engine.js`, `electron/ipc/handoffBridge/telemetry.js` |
| New synthetic suites | `scripts/tests/interview-answer-bank.js`, `scripts/tests/interview-answer-preparation.js`, `scripts/tests/interview-answer-live.js` |
| Existing test extensions and registration | `scripts/tests/interview-preparation.js`, `scripts/tests/interview-private-store-filesystem.js`, `scripts/tests/interview-window.js`, `scripts/tests/interview-window-render.js`, `scripts/tests/interview-helper-render.js`, `scripts/test-runner.js` |
| Audit | `docs/interview-helper-ux-audit.md` |

Existing unrelated uncommitted changes are not attributed to this follow-up. Protected shared transport files were reread immediately before the small additive edits; no timer logic or push-source logic was changed.

### Verification and remaining limits

Tests reject uncited text, misquotes, fabricated numbers/employers, passive subject inflation, fabricated question premises, mismatched variants, unsupported STAR labels/relationships and qualified résumé substrings. They cover every binding, tampered private artifacts/lookups, same-input replacement/recovery, deterministic resumed prompts, cancellation, third-step failure, exact/variant/ambiguous matching, honest fallback, no live model path, different-story isolation, rendering, numbered sources, keyboard and focus.

Final results: **1,828 passed, 0 failed across 36 directly run suites**, covering every Interview Helper, nonApiAi and handoff-related suite, plus `ai-models.js`. Within that total, **228 interview checks pass across all 11 interview suites**. `npm run lint`, `npm run test:resume-pdf` (12 suites / 439 checks) and `git diff --check` pass. The focused run caught missing entries in three closed bridge task vocabularies; the additive entries were added and the complete focused run then passed.

Full `npm test` was attempted; it fails in the unrelated application authority ledger because the sandbox denies `/bin/ps` (`spawn EPERM` / `spawnSync /bin/ps EPERM`) and the runner exits before its summary. The ledger/process-identity checks were not changed to hide that failure. A full-suite green result remains outstanding on a permitted host.

Logs: `/tmp/interview-answer-focused.log`, `/tmp/interview-answer-npm-test.log`, `/tmp/interview-answer-lint.log`, `/tmp/interview-answer-pdf.log`. The standalone focused runner is `/tmp/run-interview-answer-focused.mjs`, invoked with `node --import ./scripts/test-stubs/register.mjs /tmp/run-interview-answer-focused.mjs`; it imports test files matching `interview-*`, `non-api-ai*`, `handoff-*`, `application-handoff-dock.js` and `ai-models.js`, and runs each case serially with a per-case watchdog. Tests use isolated synthetic fixtures and remove their temporary stores.

Remaining limits:

- These are selected and arranged literal spoken points, not unrestricted prose synthesis. Full source wording may be longer or less conversational than desired, and sparse evidence can repeat examples. Fields over 700 characters are excluded rather than truncated; projections over 600 fields/200,000 bytes fail explicitly. No ungrounded filler is added to reach a card count or complete STAR.
- The bounded common-question catalog and conservative matcher deliberately limit paraphrase recall. Novel questions still need exact cues. The host checks truth/bindings, not whether the worker picked the most persuasive example or answered the intended question well.
- Résumé wording coverage is narrower than full semantic consistency; genuine cross-document contradiction reconciliation remains deferred item 2. Research quotes inherit the existing sealed brief's research provenance and freshness limits; no independent page-fact audit or live refresh was added.
- Every live lookup retains authoritative snapshot checks and adds local bank/artifact validation. No end-to-end live-window latency, naturalness or provider preparation-time result is claimed. The running app was preserved; production paint/clipboard behavior and contention timing still need a permitted live test. Long duplicated quotations can also increase preparation output size; the existing transport provides 16,384-token output guidance and still requires a complete valid bank.
- Legacy prepared briefs need Prepare again for cards. Failure/retry uses the existing preparation recovery workflow, including its existing invalidation of visible ready state while a replacement is being prepared.

## End-to-end live session

Date: 2026-10-30. **The browser session is implemented but blocked by this host's sandbox; this is not a completed browser audit.** Real controller and mounted React tests ran with synthetic data. No production application build, Electron launch, app restart, commit, private application store access or access to `~/Desktop/Job Search` was performed. All prior working-tree changes were retained.

### Reproduction and boundary

```bash
# Real React production bundle + CSS in a temporary directory; existing
# Chrome-for-Testing, fresh browser context, no Electron or Vite config.
node --import ./scripts/test-stubs/register.mjs scripts/interview-window-e2e.mjs \
  --label after --output-dir /tmp/interview-window-e2e-after --assert

# All interview suites, including the mandatory browser integration test.
node --import ./scripts/test-stubs/register.mjs scripts/run-interview-tests.mjs

# Node-only controller session, independently reproducible without a browser.
node --import ./scripts/test-stubs/register.mjs scripts/interview-window-controller-session.mjs \
  --output /tmp/interview-controller-after.json

npm run lint
```

`scripts/fixtures/interview-window-e2e.mjs` supplies **6 roles, 36 achievements with metrics, 11 projects, 16 prepared cards and 37 cited evidence fields**. The synthetic candidate is a product manager with analytics, onboarding, API reliability, checkout and operations experience. The CedarFlow research brief includes role themes, dated public example-domain research facts, original application wording and likely questions. The fixture uses the real evidence projection, semantic brief hash and answer-bank validator. It contains no private career data. The snapshot loader injects the approved-profile projection; it does **not** reproduce full private career-snapshot filesystem/schema validation.

The harness builds only `InterviewWindowApp.jsx` and its actual CSS with esbuild into a disposable directory. It serves those files through Playwright route fulfilment, without opening a host HTTP port. `window.interviewAPI` invokes `createInterviewWindowController` in Node, including real session locking, matching, follow-up anchoring, display projection and truth checks. Research brief and answer bank are published and independently reloaded through their real temporary sealed stores. The BrowserWindow lifecycle and IPC transport are test seams. No model/provider transport is involved.

The same 27 questions run at **420×640** and **820×900**. Every character uses Chromium key events at an accelerated 30 ms cadence; timing starts on the actual Enter keydown, so typing is excluded. A `MutationObserver` verifies the newly rendered question and exact answer text, then two `requestAnimationFrame` callbacks bound the first rendering opportunity. Full render waits for the pending state and DOM mutations to settle. This is a browser paint proxy, not compositor instrumentation. Assertions cover all 54 results, copied source text through the real browser clipboard, focus restoration, Ctrl+Enter and Cmd+Enter, Shift+Enter, follow-up, simulated native pin state, horizontal overflow, and headline/bullet/control visibility. Screenshot and detailed geometry/word-count paths are emitted in `report.json` after a successful run.

### Browser execution blocker and latency

The installed browser was found at `~/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`. The initial headless-shell probe failed with `bootstrap_check_in ... MachPortRendezvousServer ... Permission denied (1100)`. The harness then used the full existing Chrome-for-Testing executable; it also exited at launch (`SIGABRT`, process-control `EPERM`), before creating a page. A separate loopback-listen probe returned `EPERM`; route fulfilment removes that dependency from the final harness. No sandbox bypass or approval escalation was attempted.

**Screenshots produced: 0. Browser questions measured: 0.** There are no screenshot paths to report as observed evidence. `/tmp/interview-window-e2e-after/failure.json` records the failed launch and empty screenshot list; `/tmp/interview-window-e2e-after.log` contains the full attempt. The mandatory browser test fails rather than silently skipping or substituting JSDOM timings. Run the command above in a host session permitted to launch Chromium to produce the actual screenshots and browser percentiles.

| Measurement | Before p50 / p95 | After p50 / p95 |
| --- | ---: | ---: |
| Enter → first headline paint, 420×640 | Unmeasured | Unmeasured |
| Enter → full render, 420×640 | Unmeasured | Unmeasured |
| Enter → first headline paint, 820×900 | Unmeasured | Unmeasured |
| Enter → full render, 820×900 | Unmeasured | Unmeasured |
| Node controller, sealed bank read + matching + projection, 27 submits | 6.87 / 32.98 ms | 6.03 / 13.81 ms |

The controller figures are single-session observations, **not evidence of a latency speedup**. They exclude browser/native Electron IPC and painting, the production snapshot read/validation, and deliberate refresh-contention testing. Baseline and after retain 28 snapshot-loader calls and 28 sealed-bank reads including launch; no trust check or authoritative read was cached away. Raw observations: `/tmp/interview-controller-baseline.json` and `/tmp/interview-controller-after.json`.

### Match accuracy before and after

These results are from actual real-controller calls against the sealed synthetic bank. Expectations were specified in the fixture before changing matching. They judge selection against the fixture, not universal semantic accuracy or the persuasiveness of a prepared example.

| Interviewer question | Expected | Before | After |
| --- | --- | --- | --- |
| Tell me about yourself. | intro card | Correct card | Correct card |
| Why are you interested in this role? | why-role card | Correct card | Correct card |
| Why do you want to work here? | why-company card | Correct card | Correct card |
| Which experience is most relevant to this role? | relevant card | Correct card | Correct card |
| Tell me about a project you worked on. | project card | Correct card | Correct card |
| Describe a challenge you faced. | challenge card | Correct card | Correct card |
| How do you prioritize your work? | priorities card | Correct card | Correct card |
| Tell me about working with stakeholders. | collaboration card | Correct card | Correct card |
| Describe a time you faced pushback. | conflict card | Correct card | Correct card |
| Tell me about leading a team. | leadership card | Correct card | Correct card |
| Walk me through a technical problem. | technical card | Correct card | Correct card |
| Describe a process improvement. | process card | Correct card | Correct card |
| Tell me about a tight deadline. | pressure card | Correct card | Correct card |
| Describe a tradeoff you considered. | decision card | Correct card | Correct card |
| How do you understand customer needs? | customer card | Correct card | Correct card |
| Tell me about a mistake or failure. | failure card | Correct card | Correct card |
| Tell me about leadng a team. | leadership card | Abstain; missed | Correct card |
| How do you prioritise your work? | priorities card | Abstain; missed | Correct card |
| How do you handle working under pressure? | pressure card | Abstain; missed | Correct card |
| Could you briefly walk me through your background? | intro card | Abstain; missed | Correct card |
| How did you reduce Kafka consumer lag? | Exact Kafka cues | Correct cues | Correct cues |
| What was the result? (explicit Follow-up) | Same Kafka story | Correct cues | Correct cues |
| How did you reduce Kafka consumer lag, and what did you learn from that work? | Kafka cues + missing lesson warning | Correct cues/gap | Correct cues/gap |
| What are your salary expectations? | Abstain | Correct abstain | Correct abstain |
| What is your notice period? | Abstain | Correct abstain | Correct abstain |
| What telescope aperture would you choose for photographing Jupiter? | Abstain | Correct abstain | Correct abstain |
| How did you handle disagreement at RivalCo? | Abstain | **Misleading cue** | Correct abstain |

**Correct outcomes: 22/27 (81.5%) → 27/27 (100%).** Prepared matches: 16 → 20; exact-cue fallbacks: 4 → 3; abstentions: 7 → 4. Wrong prepared cards: 0 → 0. Unsafe cue fallbacks: 1 → 0. The multi-part question still explicitly reports the missing lesson; neither the fixture nor UI fills it in.

### Candidate review and fixes

1. **False negatives:** bounded normalization now handles polite delivery, Canadian/UK prioritise spelling and the grammatical “handle working under pressure” form. A typo can match only when the complete normalized prompt differs in one omission/repetition or adjacent letter transposition, resolves to one card, and does not alter a known token or factual anchor. Substitutions such as “leaving” for “leading,” changed company/number/negation, unrelated topics and ambiguous cards retain abstention. This does not add general semantic inference.
2. **False confidence:** explicit “at [employer]” requests now constrain cues to that saved role; unknown employers abstain, and a known employer's name alone cannot license another role's conflict story. Numeric and negative anchors must occur literally in a candidate cue. Added adversarial regressions cover a different known role, lowercase/unknown employers, changed metrics and negation. Other employer grammar and broad paraphrases remain conservative limitations.
3. **Question/Edit friction:** card-only responses previously showed the catalog question and lost the actual typo or paraphrase on Edit/reload. The main display now carries the submitted wording independently of an optional cue plan. Mounted React tests verify that reload and Edit preserve it and restore input focus.
4. **Compact layout:** the full locked question and concrete example now have native disclosures; their complete text and citations remain accessible. The job identity appears in the header. Desktop retains 24 px headlines / 18 px bullets; compact uses 20 px / 16 px with tighter spacing. Answer controls are fixed at the bottom with reserved content space, so long evidence can scroll without moving Next/Copy away. Citation expansion still focuses the exact complete source. **Browser geometry and the below-fold result remain unverified because Chromium did not launch.** No screenshot-based layout claim is made.
5. **Three-second reading target:** source word counts show **11–18 headline words and 31–59 words including the two bullets**. At an illustrative 250 words/minute, that is roughly **2.6–4.3 seconds for a headline and 7.4–14.2 seconds for the whole speaking surface**. These are reading estimates, not user-study results. The complete headline plus bullets do not meet a three-second reading target. The UI removes secondary detail from the initial surface, but does not cut qualifiers, rewrite facts, hide a grounding gap or fabricate shorter claims. Source authors/Prepare would need separately approved concise evidence to improve this further; existing literal truth checks remain intact. The pressure card's incident-recovery example is relevant to urgency but less directly about a planned project deadline, illustrating the remaining qualitative preparation limit.

Keyboard confidence is limited to the passing mounted-React Enter/composition/duplicate-submit/follow-up/Cmd-or-Ctrl+Enter/focus tests and the real Node session. Native clipboard permission, trusted Chromium key handling, actual always-on-top behavior and scroll/fold appearance are still pending the enabled browser integration test.

### Verification for this session

The original 11 interview suites passed **246/246** after the question-preservation and UI edits. New matching, realistic sealed-controller, mounted-React and mandatory browser cases are registered in `scripts/test-runner.js`; `scripts/run-interview-tests.mjs` discovers every `interview-*.js` suite, continues after failures and prints a complete result.

Final run: **253 passed, 1 failed across all 13 interview suites**. The sole failure is the enabled Chromium test at browser launch; the sealed-controller 27-question case and the mounted-React regression pass. All five matching regression cases pass, including their additional adversarial assertions. **`npm run lint` and `git diff --check` pass.** No all-green end-to-end result is claimed. Logs: `/tmp/interview-window-final-tests.log` and `/tmp/interview-window-final-lint.log`. Final source review also corrected the harness's cross-viewport pin reset and deliberate pointer-focus return after pinning; those browser interactions remain unexecuted on this restricted host.

## 2026-10-30 — Speakable, grounded prepared answers

The private real-run evaluation and saved final bank were read from the user-authorized `/tmp` recordings. Their principal defect was presentation and evidence choice: complete source fields, including qualifications and technology labels, were repeated as headlines and bullets. This change implements the requested spoken-claim design. It does not claim a new live-model quality score.

Prepared answer banks now use version 2. Every headline, bullet and collapsed example is a separate claim with one to four bound evidence IDs. Exact source quotations remain attached and the evidence disclosure still displays the complete original text. The host derives candor flags at projection and rederives them when checking saved evidence, so a worker or stored flag cannot override ownership restrictions. Flags cover inherited work, shared work, mixed solo/shared contributions, prior team selection, retired/replaced systems, supporting contributions, observed work, negation and approximate quantities.

Mechanical gates check citation binding, named entities and technologies, number normalization, quantity-to-unit/object binding, content-word overlap, unsupported outcomes and shipment, attribution, predicate negation, and ownership-specific verbs. Spoken numbers such as a word-form duration normalize to the corresponding numeric duration; the same number cannot become a percentage or a count of platforms. Headlines require 10–16 whitespace-separated words, an active first-person sentence, and no parentheses, colons or semicolons. Each card has 2–3 single-sentence bullets of 8–18 words. Headline/bullet copies and repeated cross-card evidence/action points fail. Exact résumé coverage and coherent career-story checks remain in force.

Selection precedes wording: the prompt includes host-ranked evidence IDs for each allowed question, using question shape and the sealed research brief's role themes. Reusing primary evidence is rejected when an unused question-fitting choice exists, even if that alternative ranks lower on role fit. Question-fit checks require supported criteria, outcomes, working patterns or problem/change evidence as appropriate. A narrower honest answer must enable `thinEvidence` when it cannot satisfy that shape; the live view shows a small **Thin evidence** warning beside the speaking material. A task involving scanned documents alone does not prove a documented technical problem. Role themes guide selection and never supply candidate facts.

After the mechanical gate, a separate preparatory entailment review checks every current claim against only its exact cited sources. Its exhaustive verdicts bind claim text, evidence IDs and field paths by digest. It checks relationships that shared vocabulary cannot prove, including causal attribution, polarity, ownership and story stitching. Negative judgments are accepted as review data, then become code-authored claim-path/rule corrections for the writer; the judge is never asked to change a negative judgment into an approval. Up to three candidate/review cycles are allowed and unsupported final answers fail before publication. Both requests use the existing allowed preparatory task with distinct prompts/schemas; no AI bridge files were changed. Live question matching still makes no AI calls.

Corrections name the failed rule and claim path without echoing rejected note strings or invented facts as writing templates. Prior literal-only banks cannot authorize spoken cards under version 2 and require Prepare again; safe exact-cue fallback remains available.

### Explicit interpretations of conflicting examples

- The diagnosis's collaboration positive explicitly says shared maintenance improved an inherited system, while its metric wording bans all improvement verbs without metrics. Source-stated maintenance improvements remain allowed; invented performance/outcome improvements do not. This preserves the requested positive without licensing a measured impact.
- Ownership restrictions apply to candidate agency. A descriptive sentence about a system, or a sentence attributing the prior choice to the team, does not assert that the candidate built or chose it. Thus the team may be named as choosing while the candidate remains limited to implementing/testing. Shared agency must retain the collaborator; purely descriptive bullets need no artificial plural subject.
- The diagnosis also proposes at most one entity or number in a headline, while its evaluator examples list multiple technologies and the user’s explicit headline contract omits that cap. The implementation uses the requested word limit plus per-entity/per-quantity truth checks instead of a separate one-entity cap, so a supported before/after result can remain a single sentence.
- Hyphenated expressions count as one whitespace-separated word. All three design-example headlines fit the 10–16 limit under this convention. Some other evaluator suggestions exceed the limit or add unsupported facts, such as an undocumented learning step, manual-work baseline or audience-needs inference. They receive no exception: supported wording must be shortened for layout, and unsupported additions remain rejected. The three requested design before/after examples are tested directly.

### Validation and rerun boundary

Regression fixtures cover the three diagnosed before/after examples, inherited construction, team-selected algorithm design, fabricated percentages, note leakage, a long headline, a headline duplicated as its first bullet, shared/solo scope, retired tense, quantity substitution, coordinated ownership verbs and unrelated negation. Preparation tests cover complete semantic-review coverage, stale digests, negative-review correction, cancellation, bounded failure, private storage and unchanged research contracts. The synthetic replay harness now includes both writer correction and entailment review, with input fingerprints and isolated output writes.

Complete verification: `node --import ./scripts/test-stubs/register.mjs scripts/run-interview-tests.mjs` ran all 17 suites, with 275 passing tests and one Chromium-launch failure. `npm run lint` passed. The Chromium test can fail before renderer startup in this execution environment; this is recorded separately from passing in-process controller and DOM tests. No app or Electron process was started, no live model was called, and neither prohibited private input directory was accessed. The existing real recordings were not rewritten or replayed against changed prompts. A new live run must use `scripts/interview-live-prepare-harness.mjs` with `--transport codex`, the same pinned snapshot/job/application inputs and a fresh `/tmp` output directory. The exact command is supplied in the delivery report for Claude to run; it is not executed here.
