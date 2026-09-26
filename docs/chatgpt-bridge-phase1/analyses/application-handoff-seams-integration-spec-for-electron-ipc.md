# Application-handoff seams: integration spec for electron/ipc/handoffBridge/ (release one, always armed, no session timers)

Design section 7 was re-verified against HEAD cbec68f. Almost every line citation still holds: getLocalApplicationHandoff is at localAiApplication.js:3863, submitLocalApplicationHandoff at :3959 and localApplicationStatus at :8861, and all three are plain exports needing no IPC sender. The bridge therefore needs ZERO edits to localAiApplication.js, NonApiAiDialog.jsx, the dock hook or applicationHandoffDock.js. What changes is the queue model. D5 (always armed) removes the "job set fixed at Start" and the 30 min / 2 h timers, so this spec replaces them with a persisted per-job RELEASE SET (native confirm at release), a persisted chat-key hash, per-job caps, human-advance auto-hold, budgets at job boundaries and stall observation computed at read time. It also fixes four places where the design and the code disagree. The get hold and wait cap are too short for renderer-driven imports. The 90 s submit watchdog exceeds ChatGPT's measured ~60 s per-call limit. The design's rule of serving the full prompt plus the app's delta correctionPrompt contradicts the app's own wording in a fresh chat. localApplicationStatus is not lock-free on two write paths. The result is a complete module map, data model, state machine, get/submit algorithms with decision tables, persistence schemas, IPC/event contract, D5/D6 lifecycle hunks in main.js, a Source interface that keeps the D4 push seam pluggable, and a test plan.

## Verified facts

- localAiApplication.js:3863-3879 getLocalApplicationHandoff, :3959-4351 submitLocalApplicationHandoff, :8861-9110 localApplicationStatus are exported async functions; the IPC wrappers are handleSafe at :9935-9938 (get/submit) and :9934 (status). None reads an IPC sender (ipcUtils.js:374-436 handleSafe adds only { success:true, ...result } and logs e.message on throw; the bridge bypasses that logging).
- Per-job FIFO mutex withLocalAiJobMutationLock at localAiApplication.js:4472-4487 wraps get, submit, import (import holds it for the whole render: :9256-9259), updateLocalApplicationDraft (:4451) and writeLocalAiRejectionFeedback (:8495-8497). localApplicationStatus is lock-free EXCEPT two write paths: writeLocalAiRejectionFeedback at :9083 (takes the lock) and endPasteJobForIntegrityFault at :4418 (takes the lock unless locked:true).
- Three code gates. G1 argument gate: handoffCode !== state.handoffCode throws a plain Error 'That handoff code is stale...' (:3963-3972) before any parse, with no tolerance. G2 envelope echo: jobId (:3248), stage (:3250), baseHashes (:3237-3239) and handoffCode (:3252); a stale echoed code is tolerated only when jobId, stage and baseHashes match and the code is in state.priorHandoffCodes (:3261-3264; MAX_PRIOR_PASTE_HANDOFF_CODES=8 at :717; rotatePasteHandoffCode :723-730). G3 content gates: requiredChangeTargets reject an unchanged answer to a reopened round.
- Every rejected answer that reaches the app mutates state: bumpPasteRejectionStreak (:4100; a rejection naming no check id DELETES the streak, :2499-2502), a Paste Rejections.json row (:4134-4141), and rememberPasteCorrections replaces the job's remembered corrections in memory and in the Paste Correction Items.json sidecar (:4142, :2187-2204). The rejection record carries draft: response (:3987, :4145), so handoff.draft is the rejected response and must never be served.
- Accept commit order at :4321-4349: drafts/<n>-<stage>.json (:4322), unlink paste-draft.json (:4323), Generation Log append (:4326), manifest.json atomic write (:4328), correction memory clear (:4345), streak clear (:4346). appendPasteGenerationLog is idempotent only for an equivalent event at the same sequence (:3538-3544) and throws 'already contains a different event' otherwise (:3545): the crash window in design section 9 is real.
- A completion-time host-validation rejection rotates the code, keeps stage 'review', and returns { accepted:false, validationErrors, localJob, handoff } with the NEW code (:4272-4318, rotate at :4288). A normal rejection returns { accepted:false, validationErrors, handoff } with the SAME code (:4143-4146). An accept returns { accepted:true, completed:false, localJob, handoff } with the next stage inline (:4349) or { accepted:true, completed:true, localJob } with no handoff (:4348).
- getLocalApplicationHandoff on a completed job returns { completed:true, handoff:null, localJob } (:3869-3871). It can write: integrity fault end (:3699-3711) and the crash recoverers recoverPasteMeasuredFitHandoff (:3723, manifest write :3770-3772) and recoverPasteHostValidationHandoff (:3789, :3853-3855); their only call site is :3867-3868. So readOnlyHint:true on get_handoff is a mismatch, as design section 17 already notes.
- Integrity faults carry error.code === 'LOCAL_AI_JOB_INTEGRITY' (pasteApplicationAssembly.js:69, isJobIntegrityFault :88, not exported by localAiApplication.js) and a message that embeds arbitrary observation text (pasteApplicationAssembly.js:77-84); never forward error.message.
- Status mapping evidence: receipt branch returns status 'saved' with folder null (:8885-8900); folder gone and no receipt returns status 'failed' with folder null (:8903-8927); a recorded integrity fault returns status 'failed' with folder set (:8984-8986, pasteIntegrityFaultStatus :4425-4433); non-completed paste stage returns status manifest.status with stage (:9003-9013); completed stage returns 'completed' | 'revision-required' | 'render-retry-required' | 'invalid' | 'importing' (:9028-9109). resolveCanvasProject (:4897-4906) throws a raw ENOENT (with an absolute path in its message) when the canvas file is missing, and localApplicationStatus calls it outside its try (:8869), so status itself throws in that case.
- Post-accept completion is renderer-driven: LOCAL_AI_POLL_INTERVAL_MS=2500 and LOCAL_AI_RESULT_SETTLE_MS=6000 (src/utils/localAiFallback.js:15-16), mounted-card poll/import in JobCardNode.jsx (~726-813, import ~505-560) or useLocalAiFallbackManager.js:469-521; import (:9245) renders PDFs and on a measured-fit failure rewrites manifest to status 'queued', stage 'review' with a rotated code (:9585-9631) and returns a handoff; the renderer then calls requestApplicationHandoffRefresh (JobCardNode.jsx:545, useLocalAiFallbackManager.js:212).
- The dock shows the DELTA correctionPrompt by default and the full stage prompt only as an escape hatch for a fresh chat (NonApiAiDialog.jsx:420-444), because pasteCorrectionPrompt says 'The earlier message in this chat still defines the schema' (localAiApplication.js:2019) and prints the shared fields with the current code. A restart-recovered round (correctionsRecovered) already folds the full prompt into correctionPrompt (pasteRecoveredHandoffPrompt :2556-2580).
- Dock plumbing citations from the design are exact: APPLICATION_HANDOFF_LIMIT=10 (applicationHandoffDock.js:33), dock label = company||title (:248), subscribeApplicationHandoffs (:436), requestApplicationHandoffRefresh (:559), discovery interval 20 s (useApplicationHandoffDock.js:29), unmount publishes [] (:287). App.jsx:34 mounts <NonApiAiDialog /> outside ErrorBoundary. Each canvas window has its own module store, so main must broadcast to every canvas window.
- discoverLocalApplicationJobs (localAiApplication.js:9845-9898) returns { id, canvasFilePath, createdAt, job, mode } with no status and includes orphans of deleted cards, confirming the design's rejection of disk enumeration for membership. registerLocalAiApplicationHandlers is :9900-9963; import's senderId is used at :9768.
- main.js anchors: registerNonApiAiHandlers :1178; startApplicationSyncServer().catch fire-and-forget precedent :1172; window:set-current-file (renderer-reported __canvasFilePath) :1197-1200; inline notify-to-all-canvas-windows pattern :1216-1220; backgroundThrottling: !isBackgroundE2E :569; production quit Promise.allSettled :1361-1365 inside the 25 s race :1375-1378; windows destroyed :1343-1352 (design said 1340-1349). Two E2E switches exist: process.env.INFINITE_CANVAS_E2E==='1' (:1205) and isBackgroundE2E() (utils/backgroundE2e.js:8).
- Test harness facts: scripts/test-stubs/electron.mjs exports app (isPackaged false), ipcMain (with __getInvokeHandler), dialog, shell, BrowserWindow, protocol, Menu, nativeImage, contextBridge, ipcRenderer, safeStorage and NO clipboard and NO powerMonitor; scripts/test-dependencies.js:51 re-exports getLocalApplicationHandoff, submitLocalApplicationHandoff, localApplicationStatus, queueLocalApplicationJob; localAiApplication.js exports _resetPasteCorrectionsForTests (:2221) and _resetPasteRejectionStreakForTests (:2544) to simulate a restart. Preload pins in tests are includes() of existing lines, so additive preload lines are safe.
- Push-side citations in design section 7 are still exact: submit handler nonApiAi.js:2386-2475 (try body 2393-2449, catch 2450-2474, log line 2471), early returns :2417-2419 and :2454-2456, requestNonApiAi sender check :1975-1981, sendRequest :1899-1911, settle :1871-1882, handler re-registration pattern :2369.
- RESULTS.md facts used: ChatGPT abandons a tool call at ~60 s and retries; calls of 10 s and 30 s were used normally; the model re-calls get_handoff several times (idempotent get required) and re-submits accepted answers rewritten (duplicate status worked); 0 real code miscopies in 124 submits; one review-stage submit was blocked twice by ChatGPT after a reconnect and never reached the server; the frozen surface is v2s (design-tools.js SURFACES.v2s: submit_handoff reworded, get_handoff unchanged).

## Design claims that no longer hold

- Section 2/5/7 'session set fixed at Start from what Jack ticked; native confirm at Start naming the jobs' does not survive D5. There is no Start. Replace it with a persisted release set (spec section 5).
- Section 2 item 9 / section 9 timers (idle 30 min, 10 min after queue_empty, hard 2 h, suspend ends the session) are void under D5. The design's other controls (chat key, budgets, caps, auto-hold) stay; time-based exposure control is replaced by data-based control (only released jobs are servable), an epoch fence, persisted holds and read-time stall observation.
- Section 5 'No startup hunk: the bridge never starts by itself' and 'nothing auto-arms' are false under D5 and D6. main.js needs a startup call (precedent :1172) and the D6 tunnel supervisor must start and stop with the bridge.
- Section 7 GET hold 10 s and 'after 8 consecutive waits -> paused' is about 80 s of waiting. A renderer-driven import needs at least a 2.5 s poll plus a 6 s settle window plus the PDF render before the job can reopen for measured fit, so the model would be paused mid-import. Use GET_HOLD_MS=20 s (measured-safe, <= 30 s) and MAX_CONSECUTIVE_WAITS=10, with a call-gap reset.
- Section 7 SUBMIT step 6 '90 s watchdog' cannot be the HTTP deadline: ChatGPT abandons at ~60 s (RESULTS.md Phase 0b). The HTTP response must be produced within ~25 s and the app call must continue unaborted so an identical retry attaches to it (verdict cache); 90 s only decides when to declare the lane stuck.
- Section 6/7 'a re-serve always carries the FULL prompt plus any outstanding corrections, plus correctionPrompt' contradicts the app's own contract in two cases: in a fresh chat the delta's sentence 'The earlier message in this chat still defines the schema' (localAiApplication.js:2019) is false, and for a restart-recovered round correctionPrompt already contains the full prompt (:2556-2580), so serving both doubles a 20-65 KB prompt. Serving rule is now epoch-aware (spec section 7.3).
- Section 7 'localApplicationStatus (lock-free...)': not on the invalid-result path (:9083 -> :8495-8497 takes the per-job lock) and not on the integrity-end path (:4418). The status call needs the same watchdog and single-flight as get.
- Section 9 'window destroy at quit (1340-1349)' is now 1343-1352, and section 7 'receipt path 8875-8896' is now 8885-8900. These are line drift only.
- Section 9 'SLEEP/WAKE: suspend ends the session; resume never re-exposes' has no object under D5. The applicable rule is: on suspend abort held gets and invalidate snapshots, on resume invalidate snapshots and re-read lazily; serving is pull-only so nothing is re-exposed by waking.
- Section 7 junk rule 'top-level jobId, stage and handoffCode must be present' was implemented differently in the lab (junk only when ALL three are absent, realistic.js:568). The lab never saw a partial envelope, so nothing measured contradicts the stricter design rule, but the stricter rule is only safe with a specific note and the 5-junk cap, and the parse-failure path must use the dock's regex extraction (pasteIdentityGuard.js:98-126) so a ChatGPT-artifact-broken answer for the wrong job is still caught.

## Specification

# Application-handoff seams: integration spec for `electron/ipc/handoffBridge/`

Baseline: HEAD `cbec68f`, clean tree. All line numbers below were read in this pass. "App code" = files that must stay unedited: `electron/ipc/localAiApplication.js`, `src/components/NonApiAiDialog.jsx`, `src/hooks/useApplicationHandoffDock.js`, `src/utils/applicationHandoffDock.js`, `src/nodes/JobCardNode.jsx`, `src/hooks/useLocalAiFallbackManager.js`.

Scope of this document: the application (pull, durable) source and the shared queue/engine behavior it forces. OAuth, HTTP, MCP framing, tunnel supervision (D6) and tool text belong to other slices. Where they touch this seam, the interface is named here.

---

## 1. Decisions this spec assumes (Jack, 2026-09-26)

| Id | Effect on this seam |
|---|---|
| D4 | Push (scoring) handoffs ship in release one. The engine must not hardcode application semantics: everything application-specific lives behind the `Source` interface (section 14). Application source is specified fully here; push source is interface-only. |
| D5 | No session, no timers. Exposure is bounded by data (release set), by an epoch fence (chat key), by persisted holds, caps and budgets, and by stall facts computed at read time. |
| D6 | The app supervises cloudflared. Lifecycle hooks in `main.js` therefore start and stop the bridge and the supervisor together (section 13). |
| Measured (Phase 0) | Frozen tool surface v2s; ChatGPT calls time out at ~60 s; holds of 10 s and 30 s were used normally; get is called repeatedly; accepted answers are re-submitted rewritten; keep-going text lives in the user's starter message. |

---

## 2. What the bridge calls, exactly (zero edits to app code)

Only `sources/application.js` imports app code, and only these three names (a source-scan test enforces it):

```js
import { getLocalApplicationHandoff, submitLocalApplicationHandoff, localApplicationStatus } from '../../localAiApplication.js';
```

### 2.1 Contracts

| Call | Args | Returns | Throws (by `error.code`, never by message) |
|---|---|---|---|
| `getLocalApplicationHandoff` (:3863) | `{ jobId, canvasFilePath }` | `{ handoff:{ jobId, stage, revision, handoffCode, baseHashes, prompt, draft, corrections?, correctionPrompt?, rejectionEscalation?, correctionsRecovered? }, localJob }` or `{ completed:true, handoff:null, localJob:{ id,status,mode,revision,logCount,folder } }` | `ENOENT` (raw fs, path in message), `LOCAL_AI_JOB_INTEGRITY`, plain `Error` (canvas ownership :8754-8761, legacy job :3668, invalid job id :5243, unreadable manifest/input), `EACCES`/`EPERM` |
| `submitLocalApplicationHandoff` (:3959) | `{ jobId, canvasFilePath, handoffCode, response }` | accepted: `{ accepted:true, completed:false, localJob, handoff }` or `{ accepted:true, completed:true, localJob }`; rejected: `{ accepted:false, validationErrors, handoff }` (+ `localJob` only on the completion-time host rejection, code ROTATED) | plain `Error` for stale argument (:3971, no code), `LOCAL_AI_JOB_INTEGRITY` (:4270 and :3708-3711), fs errors mid-commit, log-sequence errors (:3533-3548, plain) |
| `localApplicationStatus` (:8861) | `(jobId, canvasFilePath)` | `{ id, status, folder, stage?, message, ... }` | `ENOENT` when the canvas file is missing (:8869), `Error('Invalid Local AI job id.')`, fs errors |

`handoff.draft` is read only for its byte length (a human's unsent text) and is never copied into any bridge field. On a rejection `draft` is the rejected response (:3987, :4145): ignore it there.

### 2.2 What a rejected answer costs (why preflight exists)

Any answer that reaches the app and fails: bumps the escalation streak, or deletes it when no check id is named (:4100, :2499-2502); appends a `Paste Rejections.json` row (:4134-4141); replaces remembered corrections and the sidecar (:4142). The spike model sent `{}` twice (RESULTS.md). The bridge therefore filters junk, wrong-job and wrong-stage answers BEFORE the app (section 8.2). The bridge gets the app's HOST validators, not the dock's renderer guard (`pasteIdentityGuard.js`); preflight re-implements the identity part of that guard.

### 2.3 What the bridge must never do

Never call `importLocalApplicationJob` (senderId-bound save capability, :9768), `discardLocalApplicationJob`, `updateLocalApplicationDraft`, `queueLocalApplicationJob`, `discoverLocalApplicationJobs`; never write `manifest.json`, `paste-draft.json`, `fit-feedback.json`, `result.json`; never read job files itself; never import `nonApiAi.js` until the push source lands. No edit to any app file, ever, in release one.

Drift guards (new tests, section 16): `MAX_RESPONSE_BYTES` in `constants.js` equals `MAX_RESULT_BYTES` (:58) and the preflight fence regex equals the one in `parsePasteResponse` (:825), both by source-text extraction; `trimHandoffCode` and the fingerprint agree with the real `responseFingerprint` from `src/utils/pasteIdentityGuard.js` on a corpus (the test may import both; the production module may not).

---

## 3. Module map (application seam scope)

All under `electron/ipc/handoffBridge/`. Import rule for the pre-auth layer stays as in the design (`http.js`, `mcp.js`, `oauth.js`, `preflight.js`, `framing.js`: only `node:http`, `node:crypto`, siblings).

| File | Pure? | Responsibility |
|---|---|---|
| `constants.js` | yes | One frozen object of every limit (section 4.4), unit in the name. |
| `engine.js` | yes, injected `{ now, source(s), store, audit, log, random }` | Epoch, lanes, scheduler, `get()`, `submit()`, `hint()`, `release()`, `unrelease()`, `hold()`, `resume()`, `newChat()`, `status()`. No fs, no electron. |
| `lanes.js` | yes | Lane factory, state-machine transitions, code index, tombstones, counters, human-advance detection. |
| `preflight.js` | yes | `classifySubmission()`, `extractEnvelopeIdentity()`, `trimHandoffCode()`, `responseFingerprint()`. |
| `framing.js` | yes | Builders for every tool-result body, clip/scrub helpers, starter and continue messages. |
| `errors.js` | yes | Fixed-sentence table by code, `classifyThrow(err)`. |
| `store.js` | fs only | `lanes.json`, `epoch.json`, `state.json` (0600, dir 0700, tmp+rename, one serialized write chain). The OAuth slice adds its grants to the same store. |
| `sources/application.js` | DI wrapper | The three-function adapter (section 14.2). |
| `sources/push.js` | later | Interface in section 14.3 only. |
| `index.js` | electron | `registerHandoffBridgeHandlers({ notify, getCanvasWindows })`, `startHandoffBridge()`, `stopHandoffBridge()`, IPC table, native dialog and clipboard ports, status broadcast. |
| `audit.js`, `log.js`, `power.js` | | As in the design; enumerated codes only. |

Test injection: `scripts/test-stubs/electron.mjs` has no `clipboard`/`powerMonitor`, so `index.js` reads them with optional chaining and every port (`dialog`, `clipboard`, `power`, `now`) is injectable.

---

## 4. Data model

### 4.1 Lane (one released application job)

```
Lane {
  ord: int                       // persisted monotonic ordinal; used in audit and UI ordering, never the dock's chip number
  kind: 'application'
  jobId: string                  // validated at release with the app's JOB_ID_RE (:49): /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
  canvasFilePath: string         // absolute, no NUL, <= 4096; renderer-reported, NOT a trust boundary
  releasedAt: epoch ms
  phase: 'unread'|'awaiting'|'host'|'done'|'needs_user'|'held'|'gone'
  reason: null | ReasonCode      // for needs_user and held
  heldFrom: null | 'awaiting'|'host'|'unread'   // phase to return to on resume
  current: null | { code, stage, revision, promptBytes, promptSha256, corrections:[string], correctionPromptBytes, recovered:boolean, draftBytes, readAt }
  issuedCodes: Set<string>       // codes learned through the bridge's own submit results (for human-advance detection), cap 16
  servedAt: null|ms, serves: int // serves of current.code, reset when current.code changes
  submittedAt: null|ms
  hostSince: null|ms
  counters: { rejections:int, junkStreak:int, revisedRounds:int, errStreak:int, attemptByStage:{[stage@revision]:int} }
  snapshot: { at:ms, kind:'open'|'host'|'done'|'gone'|'threw', ... }   // memory only
  inFlight: { read: Promise|null, submit: Promise|null, status: Promise|null }
  retained: null | { code, text, sha256, at }   // the exact bytes of the latest attempt that reached the app; memory only; dropped on verdict, rotation, or RETAINED_BYTES_TTL_MS
}
```

`ReasonCode` (enumerated, also the only vocabulary in logs and status): `user_hold`, `human_advance`, `rejection_cap`, `junk_cap`, `review_round_cap`, `job_broken`, `render_retry`, `canvas_unavailable`, `read_failed`, `write_failed`, `submit_stuck`, `host_silent`.

### 4.2 Epoch (one ChatGPT chat)

```
Epoch { n:int, keyHash:hex64, mintedAt, bytesServed:int, bytesReceived:int,
        lastGetAt, lastSubmitAt, consecutiveWaits:int,
        focusLaneOrd: int|null,
        servedPrompt: Map<ord, { stage, code }> }   // memory only; decides delta vs full (7.3)
Retired[]: { n, keyHash, endedAt, reason:'rotated'|'full' }, last RETIRED_EPOCHS_KEPT
```

The chat key is minted by `engine.newChat()`: 10 characters from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`, printed `XXXXX-XXXXX` (port of `newSessionCode`, realistic.js:143-152). The plaintext is returned once to `index.js` (for the clipboard) and never stored. Comparison: `crypto.timingSafeEqual(sha256(trim(presented)), keyHash)`. Missing, wrong or unknown key gives a uniform `unauthorized`; a key matching a retired epoch gives `session_ended`.

### 4.3 Indexes (memory only)

- `codeIndex: Map<code, { laneOrd, stage, revision, epochN, servedAt }>`, at most CODE_INDEX_PER_LANE (16) entries per lane, oldest evicted. Codes are compared case-sensitively after `trimHandoffCode` (whitespace, ASCII and curly quotes, backticks, U+200B-U+200D, U+2060, U+FEFF at the ends only; values over 512 chars returned untouched; port of realistic.js:105-118). Never upper-case an application code.
- `tombstones: Map<code, { laneOrd, reason:'accepted'|'rotated'|'moved', at }>`, bounded 64 per engine. `duplicate` is answered only for `reason:'accepted'`.
- `acceptedFingerprints: Map<fp, { laneOrd, code }>`, bounded 32 (`responseFingerprint`: normalize CRLF/CR to LF, trim, `>= 400` chars, cyrb53 hex plus length, exactly `pasteIdentityGuard.js:35-70`).
- `verdicts: Map<sha256(code + '\0' + text), { at, promise?, verdict }>`, VERDICT_CACHE_MS.

### 4.4 Constants (`constants.js`)

| Name | Value | Basis |
|---|---|---|
| `GET_HOLD_MS` | 20_000 | Phase 0: 10 s and 30 s used normally, >= 60 s abandoned. Design said 10 s. |
| `GET_TOTAL_BUDGET_MS` | 25_000 | hold plus reads, still under 30 s |
| `SUBMIT_RESPONSE_BUDGET_MS` | 25_000 | the HTTP answer deadline; the app call is NOT aborted at this point |
| `SUBMIT_STUCK_MS` | 90_000 | design; only decides `submit_stuck` |
| `LANE_READ_WATCHDOG_MS` | 8_000 | design |
| `SNAPSHOT_TTL_MS` | 15_000 | design |
| `HOST_POLL_MS` | 4_000 | design |
| `HOST_SILENT_MS` | 600_000 | design |
| `MAX_CONSECUTIVE_WAITS` | 10 | changed from 8; about 3.3 min of waiting before `paused`. Re-tune from audited import durations |
| `WAIT_COUNTER_RESET_IDLE_MS` | 90_000 | no get for this long resets `consecutiveWaits` (call-pattern heuristic, not a session timer) |
| `VERDICT_CACHE_MS` | 60_000 | design |
| `MAX_LANES` | 10 | `APPLICATION_HANDOFF_LIMIT`, applicationHandoffDock.js:33 |
| `CODE_INDEX_PER_LANE` | 16 | design |
| `MAX_RESPONSE_BYTES` | 1_000_000 | UTF-8 BYTES, localAiApplication.js:58 and :819 |
| `MIN_ATTEMPT_CHARS` | 64 | design |
| `FINGERPRINT_MIN_CHARS` | 400 | pasteIdentityGuard.js:26 |
| `MAX_REJECTIONS_PER_JOB` | 6 | design; counts completion-time rotated-code rejections too |
| `MAX_JUNK_STREAK` | 5 | design |
| `MAX_REVISED_ROUNDS` | 8 | design |
| `ERR_STREAK_LIMIT` | 3 | consecutive read/commit failures before `needs_user` |
| `MAX_VALIDATION_ERRORS` / `MAX_VALIDATION_ERROR_CHARS` | 30 / 1500 | design; equals the app's MAX_CORRECTION_ITEM_CHARS (:1281) |
| `SOFT_BUDGET_BYTES` / `HARD_BUDGET_BYTES` | 500_000 / 900_000 | design, provisional; count every served result and every received answer, including repeated identical gets |
| `SUBMIT_CONCURRENCY` | 2 | design |
| `RETAINED_BYTES_TTL_MS` | 600_000 | new |
| `HINT_MIN_INTERVAL_MS` | 500 | new; per lane read coalescing |
| `RETIRED_EPOCHS_KEPT` | 8 | new |

---

## 5. Membership without sessions, and the controls that replace the timers

### 5.1 Release set

- A lane exists only after Jack releases that job. Release is the consent event and the data boundary: an unreleased job's prompt can never be served, whoever holds a token and a key.
- `release({ jobs:[{ jobId, canvasFilePath, label }], origin:'user'|'auto' })` in main:
  1. Validate: at most MAX_LANES active lanes after the call; `jobId` regex above; absolute path; `label` control characters stripped, 60 chars (label lives only in memory for the dialog).
  2. `origin:'user'`: ONE native `dialog.showMessageBox` (Cancel default) naming the job labels, the canvas file names and the destination host: "Send N job(s) to ChatGPT via <host>? This shares each job's listing, your career data and drafts with ChatGPT through Cloudflare." A renderer script alone cannot release (the renderer has no CSP and no sender-frame checks).
  3. `origin:'auto'` is honored only while `state.autoRelease === true`; enabling `autoRelease` itself needs its own native confirm ("every application bundle you generate will be servable to your linked ChatGPT until you turn this off"). Default `false`. This is an open question for Jack (section 19).
  4. Create lanes in `phase:'unread'`; persist (`await store.saveLanes()`) BEFORE returning; emit status.
- Membership NEVER depends on a renderer-published manifest. The dock hook publishes `[]` on unmount (useApplicationHandoffDock.js:287); an add-only release stream cannot make the queue look empty. Lanes leave only by: `unrelease`, confirmed terminal evidence (`done`, `gone`) pruned after 1 h, or `disconnect`.
- The first read validates everything: `assertRealJobDirectory` and `assertManifestCanvasOwnership` run inside get (localAiApplication.js:3653, :3667). A forged path or jobId reaches ENOENT or an ownership error, not another canvas's data.
- A `hint({ jobId, canvasFilePath })` may update a lane's `canvasFilePath` only for an existing lane (canvas renamed). Safe without re-consent because the manifest must still name that canvas.

### 5.2 What replaces "idle 30 min / hard 2 h"

| Control | Mechanism | Where |
|---|---|---|
| Data bound | Only released, non-held lanes are servable; `queue_empty` with nothing to serve returns no data | 5.1 |
| Epoch fence | One current key; New chat rotates and retires the old key; a stale chat gets `session_ended` | 4.2 |
| Persisted holds | Take over, human advance and every cap survive restarts | 11 |
| Caps | rejections 6 per job, junk 5 consecutive, revised rounds 8, read/commit errors 3 | 6 |
| Budgets | soft at a job boundary, hard mid-job, per epoch, persisted | 7.5 |
| Stall facts | `servedAt` with no submit, `hostSince`, `serves` without submit: computed when the snapshot is built or a get arrives, never by a timer | 10 |
| Quiescence | With no awaiting lane, get returns `waiting`/`paused`/`queue_empty` and carries no prompt | 7.4 |
| Kill | Disable (`setEnabled(false)`): refuse new RPCs, await in-flight <= 10 s, close listener; `disconnect` also wipes lanes, epoch and grants | 13 |

There are no main-process timers in the application seam: every deadline is an absolute time compared when a request or snapshot is processed.

---

## 6. Lane state machine

Phases: `unread` (released, never read), `awaiting` (an open handoff exists), `host` (app finishing: render, measure, save, or possible measured-fit reopen), `done`, `needs_user`, `held`, `gone`.

### 6.1 Read outcomes (from `source.read`) to transitions

| Read outcome | Transition |
|---|---|
| `open` | `awaiting`; set `current`; if the lane was `awaiting` with a different code/stage/revision and that code is not in `issuedCodes`: HELD `human_advance` (9.1) and stop; otherwise adopt |
| `host` (`completed:true`) | `host`; `hostSince ??= now` |
| `busy` (watchdog hit, promise still pending) | no phase change; `snapshot.kind='busy'` |
| `threw` integrity | `needs_user('job_broken')` |
| `threw` ENOENT | run status decision (6.2) |
| `threw` other | `errStreak++`; at ERR_STREAK_LIMIT `needs_user('read_failed')`; else retryable |

### 6.2 Status mapping (`source.status`), by fields, never by message text

| `status` | `folder` | Phase |
|---|---|---|
| `saved` | any | `done` |
| `failed` | `null` (:8918-8926, folder gone, no receipt) | `gone` |
| `failed` | set (integrity, :4425-4433) | `needs_user('job_broken')` |
| `queued` | set, `stage` != `completed` | `awaiting` (kick one read) |
| `completed`, `importing` | set | `host` |
| `revision-required`, `invalid` | set | `host`, kick one read at most every 5 s (get runs the recoverers, :3867-3868) |
| `render-retry-required` | set | `needs_user('render_retry')` (Jack's "Retry layout check" click) |
| status throws ENOENT | - | `needs_user('canvas_unavailable')` (canvas file missing or renamed) |
| status throws other | - | transient, `errStreak++` |

### 6.3 Other transitions

- Submit results: section 8.5. Human actions: `hold` -> `held('user_hold')`; `resume` -> back to `heldFrom` (or `unread`); `unrelease` -> removed (in-flight submit still completes, commit points are never aborted).
- Caps: `rejections >= 6` -> `held('rejection_cap')`, `junkStreak >= 5` -> `held('junk_cap')`, `revisedRounds >= 8` -> `held('review_round_cap')`. Counters reset on an accepted NON-final stage; `errStreak` resets on any successful app call.
- `host` lane with no state change for HOST_SILENT_MS (evaluated lazily from `hostSince`) -> `needs_user('host_silent')`, status text is an observed fact: "the app has not advanced this job in 10 minutes; is the canvas open?" (`canvasOpen` is computed in `index.js` by comparing the lane path with `getCanvasWindows()[i].__canvasFilePath`).
- A `needs_user` lane whose next read shows `open` returns to `awaiting` (Jack fixed it in the dock).
- `held` lanes are never read for serving. They ARE read by status polls only for terminal evidence (`saved`, `gone`) so a lane Jack finished by hand becomes `done`.

---

## 7. Serving

### 7.1 `get(epochKey, { signal })`

```
1  gate: key -> unauthorized | session_ended | app_unavailable (bridge disabled or quitting)
2  if nothing released                        -> queue_empty { note: nothing released }
3  budget: over HARD now                      -> session_full (mid-job is allowed here)
4  lane = pickLane()                          (7.2)   // may refresh snapshots single-flight, 8 s watchdog each
5  if lane awaiting                           -> build served body (7.3); count bytes; return
6  if any lane host/unread/busy               -> hold up to GET_HOLD_MS (10.2), then `waiting`
7  if any lane held/needs_user (none awaiting/host) -> paused { reason:'needs_user', counts }
8  else all lanes done|gone                   -> queue_empty
9  every candidate read threw (retryable)     -> error_retryable
```

Get is idempotent: no engine state changes except counters (`serves`, `servedAt`, `servedPrompt`, `bytesServed`, `consecutiveWaits`). A get within SNAPSHOT_TTL_MS of a read is answered from the snapshot with no app call. Snapshots are invalidated by: the bridge's own submit, a renderer hint, any stale outcome, suspend/resume.

### 7.2 Scheduler (depth-first per job, one active chat)

`pickLane()`:
1. `epoch.focusLaneOrd` lane if `phase==='awaiting'` and not held -> it.
2. Otherwise the first lane, ordered by (source priority, `releasedAt`), with `phase==='awaiting'`. Refresh lazily and short-circuit: refresh the focus lane first, then others in order until one is awaiting; do not read all 10 lanes per call.
3. Set `focusLaneOrd` to the chosen lane. A lane leaving `awaiting` (accept-to-host, hold, needs_user) releases focus; depth-first means the chat finishes a job's stages before another job's, but a job that is in `host` never blocks another awaiting job.
4. Source priority: push before application at job boundaries only (mirrors `mergeDockQueue`, applicationHandoffDock.js:384, push handoffs block a running pipeline while an application waits on disk); never preempt an application lane mid-correction. A push burst limit is a parameter for the push slice.

`remaining` = `{ ready, working, needsYou }` lane counts from cached phases (advisory, up to SNAPSHOT_TTL stale): ready = awaiting, working = host + unread, needsYou = held + needs_user. Lane counts, not stage counts (measured-fit reopens make stage counts unknowable).

### 7.3 What a served handoff contains (JSON in one text block)

```
{ status:'served', handoffCode, stage, attempt, instructions,
  prompt,                       // handoff.prompt VERBATIM, never modified or re-hashed
  corrections?: [string],       // clipped, path-scrubbed, <= 30 x 1500
  correctionPrompt?: string,    // only per the table below
  note?: string,                // fixed sentence, only when correctionPrompt is omitted on a correction round
  remaining }
```

`attempt` = bridge-side `attemptByStage[stage@revision] + 1`. `instructions` is a fixed constant owned by the tool-surface slice. Never served: `draft`, `jobId` (it is inside the prompt's shared fields, unavoidable, but no bridge-authored field carries it), `canvasFilePath`, `localJob`, labels, `baseHashes`, `rejectionEscalation`, `correctionsRecovered`, any error text.

Corrections rule (serve mode), decided per (epoch, lane):

| Situation | `prompt` | `corrections` | `correctionPrompt` |
|---|---|---|---|
| No corrections | yes | no | no |
| Corrections AND `epoch.servedPrompt[lane].stage === current.stage` AND `!recovered` (this chat holds the stage prompt: same-chat rejection, measured-fit or host-validation reopen) | yes | yes | yes (the app's delta, which prints the CURRENT shared fields, :2019-2026) |
| Corrections AND (first serve of this lane in this epoch, i.e. fresh chat or after New chat) | yes | yes | NO; `note` = fixed sentence "The listed fixes apply to a corrected answer to this prompt." |
| `recovered` (app restart, :2556-2580) | yes | yes | NO (it already contains the prompt; sending both doubles 20-65 KB) |

`servedPrompt` is memory only, so after an app restart the first serve of a corrections round is the safe full-prompt form.

### 7.4 `waiting`, `paused`, `queue_empty`, `session_full`

- `waiting { pollCount, retryAfterSeconds:5, remaining, note }`. `pollCount = consecutiveWaits + 1`. `consecutiveWaits` resets on any non-waiting result and after WAIT_COUNTER_RESET_IDLE_MS without a get.
- `paused { reason:'waiting_limit'|'needs_user', remaining, note }` when `consecutiveWaits >= MAX_CONSECUTIVE_WAITS` or nothing is servable and something needs Jack. The note names counts only.
- `queue_empty` requires every released lane `done` or `gone`, and at least one lane, or nothing released (then the note says nothing is released). Never `queue_empty` after an empty publish or while any lane is `unread`, `host`, `awaiting`, `held` or `needs_user`.
- `session_full`: `bytesServed + bytesReceived >= SOFT` and the current job is at a boundary (accepted-to-host or done), or `>= HARD` at any point. Jack starts a New chat; the next chat resumes from `get_handoff` alone because a serve is self-contained.

---

## 8. Submitting

### 8.1 Pipeline

```
submit(epochKey, codeArg, response, { signal })
 1  gate: key; enabled
 2  normalize: code = trimHandoffCode(codeArg); response string as-is; plain object -> JSON.stringify (parsePasteResponse accepts objects, :848-852); anything else -> junk
 3  size: Buffer.byteLength(text,'utf8') > MAX_RESPONSE_BYTES -> too_large (no app call, no counters)
 4  shape = classify(text) (8.2)        // pure: parsed object or regex identity
 5  route (8.3): lane, codeToUse
 6  lane gates: held -> held; gone -> unknown_handoff; needs_user -> needs_user; host -> superseded
 7  preflight verdict (8.2): junk | misrouted | superseded | pass
 8  verdict cache / in-flight attach (8.4)
 9  concurrency: at most SUBMIT_CONCURRENCY app submits at once (a slot waits, still inside the 25 s budget)
10  app call (8.5) -> map result (8.6)
11  post: emit application-changed, persist counters if changed, audit
```

### 8.2 Preflight (pure, no app call, no counters except `junkStreak`)

Order: (a) empty, whitespace, `{}`, `[]` -> `junk`. (b) Fence: `/^```(?:json)?\s*\n([\s\S]*?)\n```$/i` on the trimmed text (byte-identical to the app, :825). (c) `JSON.parse`:

- Parsed, not a plain object -> `junk`.
- Parsed, any of `jobId`, `stage`, `handoffCode` missing or not a non-empty string -> `junk` (note names the shared fields).
- `parsed.jobId !== lane.jobId` -> `misrouted` (whether it is another lane's id or unknown; no app call, no counters).
- `parsed.stage !== lane.current.stage` -> `superseded`.
- Fingerprint of the normalized text matches an ACCEPTED answer of a DIFFERENT lane -> `misrouted`.
- Otherwise `pass`. Values of `handoffCode` echo and `baseHashes` are NOT compared: the app grades them and tolerates a retired echo (:3261-3264).
- A `patches` delta review answer passes (it carries the shared envelope, :4067).

Parse failure: if `text.trim().length >= 64 && text.includes('{')` -> `pass` (a real attempt gets the app's own truncation and syntax diagnostics, :784-815, and its ChatGPT content-reference repair, :835-843); else `junk`. On the failure path also run `extractEnvelopeIdentity` (regex port of pasteIdentityGuard.js:98-126): an extracted `jobId` that differs from the lane's -> `misrouted`; an extracted `stage` that differs -> `superseded`. Extraction never blocks on unfamiliar values it cannot compare.

`junkStreak` increments on `junk`, `misrouted`, `superseded`-by-preflight; resets on `pass`.

### 8.3 Routing (by the code, never by `response.jobId` alone)

1. `codeIndex[trimmed arg]` -> lane. Then if `lane.current.code !== arg`: the code is retired: tombstone `accepted` -> `duplicate`; `rotated`/`moved` -> `superseded`.
2. Index miss (first call after a restart, or the model mis-copied): if the parsed envelope's `handoffCode` equals the CURRENT code of the lane named by `parsed.jobId`, route there with `codeToUse = lane.current.code` and mark `codeArgCorrected` (envelope is authoritative, the app grades it anyway). Refresh stale snapshots first (single-flight).
3. Still no lane: tombstone -> `duplicate`/`superseded`; else `unknown_handoff`.

The argument the app receives is always the lane's CURRENT app code (`codeToUse`). G1 (:3963) is strict equality, so passing a retired code would throw.

### 8.4 Verdict cache and in-flight attach

Key `sha256(codeToUse + '\0' + text)`. An identical call within VERDICT_CACHE_MS attaches to the in-flight promise or replays the stored verdict (a re-run would double-count the rejection streak and rewrite the sidecar). An accepted verdict replays with `next` recomputed fresh. This is what makes ChatGPT's ~60 s abandon-and-retry safe: the HTTP handler answers at `SUBMIT_RESPONSE_BUDGET_MS` with `retry` (fixed note, `inFlight:true`) while the app call continues unaborted; the retried identical call attaches. `signal` (client gone) cancels only waiting and holding, never an app call.

`lane.retained = { code, text, sha256 }` is set before the app call and cleared on any returned result. It exists only for the crash-window recovery (8.7).

### 8.5 The app call

`source.submit(lane, { code, text })` -> `submitLocalApplicationHandoff({ jobId, canvasFilePath, handoffCode: code, response: text })`. Watchdog SUBMIT_STUCK_MS only marks `needs_user('submit_stuck')`; the promise is kept.

### 8.6 Result mapping

| App result | Lane effect | Tool result |
|---|---|---|
| `accepted && !completed` | `current` = returned `handoff` (rotated code); tombstone old code `accepted`; `issuedCodes.add(new)`; record `acceptedFingerprints`; `attemptByStage` cleared; `rejections`, `junkStreak` reset; `revisedRounds++` if the accepted stage was `review` and the next stage is `review` again; snapshot replaced | `{ status:'accepted', next:<served body, mode full, no corrections> }` |
| `accepted && completed` | phase `host`, `hostSince=now`; tombstone `accepted`; snapshot invalid | `{ status:'accepted', jobComplete:true, next:<next lane without long-poll: served | waiting | queue_empty | session_full | paused> }` |
| `!accepted`, same code | `rejections++`, `attemptByStage[..]++`; new corrections from `validationErrors` (path-scrubbed, clipped); cap check | `{ status:'rejected', handoffCode, attempt, validationErrors, correctionPrompt, note }` (delta is valid: the chat holds the prompt) |
| `!accepted`, code CHANGED (`localJob` present, completion-time host rejection) | as above but `current` = returned handoff (NEW code), old code tombstoned `rotated`, `issuedCodes.add(new)` | same shape with the NEW `handoffCode` |
| throw | 8.7 | per table |

`accepted && completed` never yields `queue_empty` for the lane that just completed: it is `host` and may reopen for measured fit (:9585-9631).

### 8.7 Throw handling (decisions by re-read, never by message text)

| Observation | Action |
|---|---|
| `error.code === 'LOCAL_AI_JOB_INTEGRITY'` | `needs_user('job_broken')`; result `needs_user` with the fixed sentence; the app's message embeds arbitrary text and is never forwarded |
| any other throw: re-read `open`, fresh code differs, fresh stage equals the stage the call was made against, not yet retried | retry once with the fresh code and the same bytes (the envelope echo tolerance covers the retired code, :3261-3264) |
| re-read `open`, fresh code differs, stage differs | apply read (human-advance rule 9.1), result `superseded` |
| re-read `host` | phase `host`; result `superseded` |
| re-read `open`, SAME code, not yet retried | resubmit `lane.retained` bytes once (crash window between :4326 and :4328: an equivalent event recovers, :3544) |
| same code, already retried | `errStreak++`; at 3 `needs_user('write_failed')`; result `retry` |
| re-read `threw` ENOENT | status decision 6.2 (`saved` -> lane `done`, result `duplicate`; `gone` -> `unknown_handoff`; canvas missing -> `needs_user('canvas_unavailable')`) |
| re-read `busy` | `retry` |

At most two internal resubmissions per call. If a later model submission arrives for the same code with DIFFERENT bytes while `lane.retained` is set from a call that threw, replay `retained` first; if that returns accepted, answer `accepted` (with `next`), else fall through. The app-side fix for the crash window (recover when `manifest.logCount` is behind the log tail) remains design decision D7 and matters more now, because a restart between the throw and the retry loses `retained` and a re-written answer then wedges the stage (:3545).

### 8.8 Submit statuses

`accepted`, `rejected`, `junk`, `misrouted`, `superseded`, `duplicate`, `held`, `unknown_handoff`, `needs_user` (with `reason`), `retry`, `too_large`, `session_ended`, `session_full`, `unauthorized`. Notes are fixed strings from `errors.js`/`framing.js`; the lab's `NOTES` (realistic.js:32-57) are the starting text. Whether results use the "directive" or "facts" wording is owned by the tool-surface slice; both drained in the measured runs, and ChatGPT's dialog demonstrably summarizes text it reads, so "facts" is the safer default. No note may contain a job id, code, path or scraped string.

---

## 9. Human versus bridge

### 9.1 Auto-hold (the human always wins)

On every read of a lane in `awaiting`: if `read.code !== lane.current.code` (or stage/revision differ) and `read.code` is not in `lane.issuedCodes`, a non-bridge writer advanced the job (dock submit accepted). Set `held('human_advance')`, keep serving nothing from it, emit. Codes the bridge learns from its own accept/reject results are in `issuedCodes`, so its own transitions never self-hold. Host-phase changes (measured-fit and host-validation reopens) are expected and adopted silently. A changed corrections list with the same code (a human rejection in the dock) is adopted, not held.

`draftBytes > 0` on a served lane is surfaced as an observation ("the dock has an unsent draft for this job"), never as a block. The paste box is never disabled. A bridge accept unlinks the human's `paste-draft.json` (:4323), and the dock adopts the disk draft when the code changes (NonApiAiDialog.jsx:895-905); the panel copy says not to type into a chip ChatGPT is driving.

### 9.2 Hints (renderer to main)

`hint({ jobId, canvasFilePath? })` invalidates that lane's snapshot, wakes holding gets, and is coalesced to one read per lane per HINT_MIN_INTERVAL_MS. It emits nothing back unless the lane's state actually changed (held, gone, done), which makes the loop dock -> panel -> hint -> read -> event -> dock refresh finite.

---

## 10. After the last accepted review (renderer-driven completion)

### 10.1 What happens without the bridge

After the final accept, manifest is `paste-completed` and `result.json` exists. A mounted card or the fallback manager polls status every 2.5 s, waits a 6 s settle window, calls `importLocalApplication` (renders both PDFs, may loop fit attempts), then `saveApplication`. On measured-fit failure import reopens `review` with a rotated code (:9585-9631) and the renderer requests a dock refresh. All of this needs a renderer with the canvas open; the bridge cannot do it (import needs the sender-bound capability, :9768).

### 10.2 Bridge behavior while a lane is `host`

Get holds up to GET_HOLD_MS. Every HOST_POLL_MS (single-flight per lane) it calls `source.status`; it is also woken by hints. On `awaiting` it reads and serves. On `done` it marks the lane. There are NO background pollers when no get is outstanding: the dock and cards already track host progress, and the panel derives relative times client-side from `hostSince`. Import duration (`hostSince` to next transition) is recorded in the audit ledger so MAX_CONSECUTIVE_WAITS and GET_HOLD_MS can be tuned from real data.

### 10.3 Stall observations (facts only)

`served at T, no submit since` (`servedAt`, `submittedAt`); `served N times without a submit` (`serves`); `host since T`; `canvasOpen`. The panel never says "blocked" (a ChatGPT block never reaches the server, RESULTS.md Phase 0). Threshold for a notice: 4 min after a serve.

---

## 11. Persistence

Files under `<userData>/handoff-bridge/` (dir 0700, files 0600, `{ version:1 }`, unknown version = treated as empty, write = tmp + rename through one serialized chain). Nothing goes in electron-store (`get-settings` returns the whole store to the renderer) and nothing in node data (no versioned migration needed).

`lanes.json`
```
{ "version":1, "nextOrd":4,
  "lanes":[{ "ord":3, "jobId":"<uuid>", "canvasFilePath":"/abs/Canvas.json", "releasedAt":1758900000000,
             "phase":"held", "reason":"user_hold", "heldFrom":"awaiting",
             "counters":{ "rejections":2, "junkStreak":0, "revisedRounds":1 } }] }
```
Written and awaited on: release, unrelease, hold, resume, human-advance hold, any cap hold, needs_user, done/gone, counter changes (rare). Holds are awaited before the IPC call returns, so a crash cannot resume serving a job Jack took over.

`epoch.json`
```
{ "version":1,
  "current":{ "n":7, "keyHash":"<64 hex>", "mintedAt":..., "bytesServed":183422, "bytesReceived":41200 },
  "retired":[{ "n":6, "keyHash":"<64 hex>", "endedAt":..., "reason":"rotated" }] }
```
Only hashes at rest. Byte counters are flushed debounced (5 s) and on `stopHandoffBridge()`. Purpose: an open ChatGPT chat survives an app restart (it holds the key in its own context; any user message makes it call get_handoff again). Not recoverable after a restart: the plaintext key, so the "Copy continue message" button is unavailable until a New chat (the panel says so).

`state.json` (shared with the OAuth slice): `{ enabled, autoRelease, publicBase, ... }`.

Never persisted: code index, tombstones, snapshots, verdict cache, `retained` bytes, `servedPrompt`, in-flight promises. After a restart the worst cases are an `unknown_handoff` (the model re-gets and receives the same prompt, since codes rotate only on accept) and a first correction serve in full-prompt form.

Startup rehydration: read `lanes.json` and `epoch.json`; every lane comes up `unread` (except `held` and `needs_user`, which keep their phase and reason); no app call at startup; the first get or hint reads. Lanes released with `canvasFilePath` missing on disk go `needs_user('canvas_unavailable')` on first read.

Audit ledger (`audit.jsonl`, 0600, rotate 1 MiB keep 2), application events only: `{ t, ev, ord, stage, outcome, bytes, ms, epoch }` where `ev` is one of `lane_released, lane_unreleased, served, submit_accepted, submit_rejected, submit_junk, submit_misrouted, submit_superseded, submit_duplicate, submit_unknown, submit_retry, lane_held, lane_resumed, lane_needs_user, lane_done, lane_gone, epoch_new, epoch_full, host_duration, read_busy, read_error`. Never job ids, codes, labels, paths, keys or text.

---

## 12. Renderer contract

### 12.1 IPC (invoke; plain `ipcMain.handle` with try/catch, NOT `handleSafe`, so no `e.message` reaches `logger.error`; re-register-safe with `removeHandler` as in nonApiAi.js:2369)

| Channel | Payload | Main behavior | Return |
|---|---|---|---|
| `handoff-bridge:get-status` | none | snapshot 12.3 | `{ success, status }` |
| `handoff-bridge:set-enabled` | `{ enabled }` | native confirm on enable; start/stop (13) | `{ success, code? }` |
| `handoff-bridge:set-auto-release` | `{ enabled }` | native confirm on enable; persist | `{ success }` |
| `handoff-bridge:release` | `{ jobs:[{ jobId, canvasFilePath, label }] }` | 5.1 | `{ success, released:[jobId], refused:[{ jobId, code }] }`, codes `invalid_job_id`, `invalid_path`, `limit_reached`, `declined`, `disabled` |
| `handoff-bridge:unrelease` | `{ jobId }` | remove lane, wait for its in-flight promise <= 10 s | `{ success }` |
| `handoff-bridge:hold` | `{ jobId }` | `held('user_hold')`, awaited persist | `{ success }` |
| `handoff-bridge:resume` | `{ jobId }` | back to `heldFrom`; clears caps that caused a cap hold | `{ success }` |
| `handoff-bridge:new-chat` | none | mint key, retire old, reset counters, copy starter via main-side `clipboard.writeText` | `{ success, copied, epoch:n }` (no key) |
| `handoff-bridge:continue-message` | none | copy continue text (only while the plaintext key is in memory) | `{ success, copied }` |
| `handoff-bridge:hint` | `{ jobId, canvasFilePath? }` | 9.2 | `{ success }` |

Validation in main: `BrowserWindow.fromWebContents(event.sender)` must be a canvas window; every field type-checked and bounded before use. No secret (key, pairing code, client secret, token) ever crosses IPC in either direction.

### 12.2 Events (main to renderer, sent to EVERY canvas window: each window has its own dock store)

- `handoff-bridge:status`: full snapshot 12.3, coalesced (trailing 250 ms).
- `handoff-bridge:application-changed`: `{ jobId, reason:'accepted'|'rejected'|'host'|'held'|'resumed'|'released'|'unreleased'|'done'|'gone'|'needs_user' }`. Fired after any bridge-caused change; the renderer answers with `requestApplicationHandoffRefresh(jobId)` (applicationHandoffDock.js:559). The dock's own submit does exactly this after every result (NonApiAiDialog.jsx:1188, :1207); without it a bridge-advanced chip would show a retired prompt until the 20 s safety interval (useApplicationHandoffDock.js:29). A refresh for a job not in that window's candidate set is a no-op there (`toFetch` empty, :112-114 region).

Preload (additive, after :196; existing pins are `includes()` of other lines): `handoffBridgeGetStatus`, `handoffBridgeSetEnabled`, `handoffBridgeSetAutoRelease`, `handoffBridgeRelease`, `handoffBridgeUnrelease`, `handoffBridgeHold`, `handoffBridgeResume`, `handoffBridgeNewChat`, `handoffBridgeContinueMessage`, `handoffBridgeHint`, `onHandoffBridgeStatus = createListener('handoff-bridge:status')`, `onHandoffBridgeApplicationChanged = createListener('handoff-bridge:application-changed')`. The OAuth/tunnel slices add their own.

### 12.3 Status snapshot (no prompt, code, key, canvas path, label)

```
{ enabled, autoRelease,
  epoch: { n, bytesServed, bytesReceived, budgetPct, lastGetAt, lastSubmitAt } | null,
  lanes: [{ ord, jobId, phase, reason, stage, attempt, serves, servedAt, submittedAt, hostSince,
            rejections, draftBytes, canvasOpen }],
  counts: { ready, working, needsYou, done } }
```

### 12.4 Panel behavior (new `HandoffBridgePanel.jsx`, `src/utils/handoffBridgeQueue.js`; no edits to app UI code)

- Mounted once in `App.jsx` after `<NonApiAiDialog />` (App.jsx:34), outside `ToastProvider`. Inline `useRef/useState`, hooks above any early return (React Compiler lint rules).
- Job checklist is built from `subscribeApplicationHandoffs` (applicationHandoffDock.js:436): items with `kind==='application'`; `handoffBridgeQueue.js` maps `integrityMessage` -> broken, `working`/`workingState` -> working|blocked, `unreadable` -> working, `handoffCode && prompt` -> awaiting, and strips `prompt`, `handoffCode`, `initialResponse`, `corrections`. It names jobs by `label` (escaped text), never by chip ordinal.
- Hint emission: per released job compute `sig = handoffCode|stage|revision|corrections.join('\0')|workingState|integrityMessage` (same construction as the dock's `correctionSignature`, NonApiAiDialog.jsx:268-270); on change, debounced 250 ms, call `handoffBridgeHint({ jobId })`.
- Subscribe to `onHandoffBridgeApplicationChanged` and call `requestApplicationHandoffRefresh(jobId)`.
- Relative times ("served 6 min ago") come from a 30 s renderer tick over snapshot timestamps.

### 12.5 What the dock already does that the bridge relies on (no change needed)

The dock re-reads on refresh and adopts a new code, discarding its stage-scoped ephemeral state and restoring the disk draft (NonApiAiDialog.jsx:887-905); it never renders the app's stale-code throw for application items (:591-593, pre-existing); its fingerprint memory (`recordSubmittedResponse`, :1102-1124) does not know about bridge accepts, and the host still rejects a cross-job paste on jobId.

---

## 13. Lifecycle hunks in `electron/main.js` (all additive)

1. Import: one line near :24.
2. After `registerNonApiAiHandlers()` (:1178), inside a try/catch (a synchronous throw in the `whenReady` callback would skip `createWindow`, see the comment at :927-943):
   `registerHandoffBridgeHandlers({ notify, getCanvasWindows: () => [...canvasWindows] });`
   `startHandoffBridge().catch((err) => logger.warn('[main] handoff bridge failed to start'))` (fire-and-forget, the precedent is `startApplicationSyncServer().catch` at :1172; log no `err.message`, see design T7).
   `startHandoffBridge` is a no-op unless `state.enabled`, refuses under `process.env.INFINITE_CANVAS_E2E === '1'` (:1205) or `isBackgroundE2E()`, unless `app.isPackaged` (or `INFINITE_CANVAS_HANDOFF_BRIDGE_DEV=1`), and when `INFINITE_CANVAS_HANDOFF_BRIDGE=0`. It is idempotent and memoizes an in-flight start. It starts the loopback listener and, under D6, the tunnel supervisor.
3. Quit: `stopHandoffBridge()` as a fourth entry of the production `Promise.allSettled` at :1361-1365 (inside the 25 s race, :1375-1378). It refuses new RPCs, awaits in-flight get/submit up to 10 s (a commit point is never aborted; pull accepts do not depend on windows, which are destroyed first at :1343-1352), flushes `epoch.json`/`lanes.json`, closes connections, stops the supervisor. The pinned E2E quit block (regex in electron-regressions.js:115-116) is untouched because the bridge never runs under E2E.
4. `notify` for status/events reuses the inline pattern at :1216-1220 (`for (const win of canvasWindows) if (!win.isDestroyed()) win.webContents.send(event, data)`).
5. Optional (design Phase 2, measured first): `webContents.setBackgroundThrottling(false)` on canvas windows while any lane is `host` (production windows keep throttling on, :569; renderer-driven import timers are the exposure). `power.js` is optional-chained (no `powerMonitor` in the stub or the app today): on `suspend` abort held gets and invalidate snapshots; on `resume` invalidate snapshots.

---

## 14. Source interface (keeps D4 pluggable)

### 14.1 Interface

```
Source {
  kind: 'application' | 'push'
  normalizeCode(raw): string            // application: trimHandoffCode (case kept); push: trim + toUpperCase (nonApiAi.js:2277-2278)
  preflightRules: { minAttemptChars, shortForms, requiredEnvelopeKeys }   // application: 64, ['', '{}', '[]'], jobId+stage+handoffCode; push: 0, ['', '{}', '[]' only], none
  read(lane, { signal }): { kind:'open'|'host'|'done'|'gone'|'busy'|'threw', handoff?, code?, integrity?, enoent? }
  status(lane, { signal }): { kind:'phase', phase, reason? } | { kind:'threw', ... }
  submit(lane, { code, text }): { kind:'accepted', completed, next? } | { kind:'rejected', validationErrors, handoff, rotated } | { kind:'threw', integrity?, enoent? }
}
```
The engine owns lanes, epochs, scheduling, budgets, caps, hints, verdict cache and persistence; a source owns only its three calls and the vocabulary above.

### 14.2 `sources/application.js`

- `read`: races `getLocalApplicationHandoff` against LANE_READ_WATCHDOG_MS and returns `busy` on timeout while KEEPING the promise (single-flight; the app call is queued behind an import on the per-job lock and settles later). `completed:true` -> `host`. Otherwise copies only `{ code, stage, revision, prompt, corrections[], correctionPrompt, recovered: Boolean(correctionsRecovered?.active), draftBytes: byteLength(handoff.draft) }`, validating that `code`, `stage`, `prompt` are non-empty strings, else `threw {shape}`.
- `status`: races `localApplicationStatus` against the same watchdog; maps by table 6.2.
- `submit`: no abort; maps per 8.6. `draftBytes` is ignored on submit results.
- `classifyThrow`: `{ integrity: code==='LOCAL_AI_JOB_INTEGRITY', enoent: code==='ENOENT', eaccess: code in ['EACCES','EPERM'] }`. It never reads `.message`.

### 14.3 Push (interface only; the push slice owns the rest)

Push records are parked promises tied to a renderer sender (`requestNonApiAi` throws without a sender, nonApiAi.js:1975-1981), keyed by `requestId`, non-durable; codes are `HANDOFF-XXXXXX`, deterministic and recurring (tombstones keyed by `(requestId, code)`); `read` = whitelist projection of `pendingRequests`; a destroyed sender = `gone`; there is no `host` phase (settle = `done`). Design section 7's line citations for that seam (:2393-2474 hoist range, :1899-1911, :1871-1882, :2417-2419, :2454-2456) are still exact.

---

## 15. Privacy and error mapping at this seam

- Every outcome maps to a fixed sentence by `error.code`/class/enum. `error.message`, stack, `localJob` (contains an absolute `folder`), `handoff.draft`, and the integrity observation are never forwarded, logged, audited or put in telemetry.
- Only app-authored sentences about the caller's own answer pass through: `validationErrors[]` and `correctionPrompt`. Scrub absolute-path-looking substrings (`/Users/...`, `/home/...`, `X:\...`), clip each item head 65% / tail 35% with a marker as `clipCorrectionItem` does (:1284-1290), cap 30 items x 1500 chars and add "N more not shown".
- App rejection sentences are written for a human at the dock ("Find the chat holding...", "Copy the current prompt", "Start a fresh chat with the full prompt", :3249, :3264, :3971). The bridge appends a fixed `note` to every `rejected` result saying the corrected COMPLETE answer goes back through `submit_handoff` with the code the result names; the stale-argument throw is never forwarded.
- Logs and audit take enumerated codes only; the app's own `logger` lines (which include job ids) are unchanged and out of scope.
- Sentinel test: a scripted run with a capturing logger must show no prompt text, response text, handoff code, chat key, job id, canvas path or label in any log line, status payload, audit line or IPC return.

---

## 16. Test plan (registered in `scripts/test-runner.js`; new unique names; no test binds a port)

`scripts/tests/handoff-bridge.js` (pure DI, fake clock, fake Source): routing (index hit, envelope-code fallback, tombstone duplicate vs superseded, unknown), depth-first scheduling across 3 lanes incl. a host lane not blocking an awaiting lane, idempotent get, snapshot TTL and hint invalidation, hold loop wake, `waiting`/`paused`/`queue_empty` truth table (never `queue_empty` on unread/host/held/needs_user or empty publish), consecutive-wait reset by idle gap, budgets at job boundary vs hard, caps (6/5/8/3) and their resume, human-advance auto-hold with and without `issuedCodes`, verdict cache attach/replay (identical retry does not call the source twice), 25 s submit budget returns `retry` while the promise continues and a later identical call attaches, epoch rotation fences the old key (`session_ended`), uniform `unauthorized`, persistence round trip (lanes, holds, key hash, counters), startup rehydration (no app call at start), release validation and limits.

`scripts/tests/handoff-bridge-preflight.js`: table of junk (`''`, whitespace, `{}`, `[]`, 63-char no-brace, non-object JSON, missing each of jobId/stage/handoffCode), misrouted (other lane's jobId, unknown jobId, regex-extracted jobId on an unparseable answer), superseded (stage), fingerprint block only for a DIFFERENT lane's accepted text, fenced JSON identical to the app's regex, a `patches` delta passes, a 30 KB syntax-broken answer passes through, byte (not char) size cap with a multibyte string. Drift tests: constants equal source text at :58 and :825; `trimHandoffCode` cases (whitespace, curly quotes, backticks, zero-width, never touches interior, never upper-cases); `responseFingerprint` equals the real one from `pasteIdentityGuard.js` on a corpus.

`scripts/tests/handoff-bridge-application.js` (real app functions, scratch canvas, `queueLocalApplicationJob`, style of paste-application-flow.js:1-140): the bridge get returns the same prompt bytes as `getLocalApplicationHandoff`; a valid stage answer is accepted and the next stage arrives inline with a rotated code; a schema-invalid answer is rejected with the app's own `validationErrors` and the SAME code; a completion-time host rejection rotates the code and the result carries the new one; a stale argument code triggers the re-read path (fresh code, same stage -> one retry; different stage -> `superseded`); a human-path submit followed by a bridge submit gives `superseded` and auto-hold; `{}` and wrong-job submits leave `Paste Rejections.json`, `Paste Correction Items.json` and `getPasteHandoffDiagnosticsSnapshot()` unchanged (this is the parity proof for preflight); an integrity fault maps to the fixed sentence with no path or observation text; a mid-import lane (hold the per-job lock with a pending promise) answers `busy` within the watchdog and never blocks another lane; a measured-fit reopen after `completed` is served with `correctionPrompt` only when the epoch served that stage; a `_resetPasteCorrectionsForTests` restart round is served in full-prompt form with no `correctionPrompt`; crash-gap: force the log append to succeed and the manifest write to fail (fault-inject `atomicJson` target) and prove an identical-bytes resubmit recovers, a different resubmit is mapped to `retry`/`needs_user` and never leaks the error text; `discard` mid-serve gives `gone` via ENOENT plus status, never a message match.

`scripts/tests/handoff-bridge-source-scan.js`: only `sources/application.js` imports `localAiApplication.js` and only the three names; nothing in the directory imports `nonApiAi.js` before the push slice; no `.message`, `.stack`, `req.url` in any log/audit call; pre-auth files import only `node:http`, `node:crypto`, siblings; `git diff --stat` zero lines in the six app files listed at the top; main.js hunks additive and the pinned quit regex still matches.

Panel/renderer: no test mounts a component, so the manual gate stays: two or more pending handoffs, a live linked chat, a human paste and Take over mid-session, and a host lane completing with the canvas open and closed. `handoffBridgeQueue.js` gets a pure test including a drift test importing the `APPLICATION_DOCK_*` constants.

Gates before real data: `npm test` (0 failed, never the bare runner), `npx eslint .`, `npm run build:compile`, `npm run test:e2e` with the bridge absent and inert.

---

## 17. Flows

Happy path, one job: release (native confirm) -> New chat (key minted, starter copied) -> chat calls `get` -> `served` evidence-plan (prompt verbatim) -> `submit` -> preflight pass -> app accepts -> `accepted` + `next` resume stage (rotated code) -> ... -> review accepted `completed` -> lane `host`, result `accepted, jobComplete, next: waiting` -> chat calls `get`, bridge holds 20 s polling status every 4 s -> renderer imports (2.5 s poll, 6 s settle, render) -> `saved` -> lane `done` -> `queue_empty`.

Rejection: `submit` -> app `rejected` (same code) -> `rejected { handoffCode, attempt:2, validationErrors, correctionPrompt, note }` -> model resubmits complete corrected answer -> `accepted`. Same chat, so the delta is valid.

Measured-fit reopen: lane `host`; import fails fit; app writes `queued/review` with a new code; renderer requests a dock refresh; the panel hint wakes the holding get; read `open` with corrections; because this epoch served that lane's review stage, serve prompt + corrections + delta `correctionPrompt`.

Human advance: Jack accepts stage 2 in the dock while the chat is composing; the model's submit arrives with the stage-2 code: `codeIndex` hit, `current.code` differs, tombstone `moved` -> `superseded`; the next read sees a code not in `issuedCodes` -> `held('human_advance')`; the chat is told `held`.

Restart mid-chat: lanes/holds/counters/key hash restored; codes and tombstones gone; the open chat's next get works (same key); a submit for an old code is `unknown_handoff` -> get -> same prompt (codes rotate only on accept).

---

## 18. Build order (each step shippable and inert)

1. `constants`, `preflight`, `framing`, `errors`, `lanes`, `engine` with fake Source + `handoff-bridge*.js` unit tests.
2. `sources/application.js` + `handoff-bridge-application.js` integration tests against the real app functions (this is where the seam claims above get proven).
3. `store.js` persistence + rehydration + audit.
4. `index.js` IPC, preload lines, main.js hunks, `HandoffBridgePanel`, `handoffBridgeQueue`, App.jsx line. Off by default, hard-off by env.
5. D4 push `Source` (separate slice), then link with the OAuth/http/tunnel slices.

---

## 19. Open questions for Jack (decisions this spec cannot make)

1. Release model under D5: explicit per-job release (default in this spec, one native confirm per batch) or `autoRelease` (every Generate is servable, one confirm when toggled on). Same code either way.
2. Should a release persist across app restarts as standing consent (this spec: yes) or be re-confirmed at launch?
3. Persist the chat-key HASH so an open chat survives an app restart (this spec: yes; cost: no "Copy continue" after a restart until New chat).
4. Wait/hold values: 20 s x 10 (this spec) versus the design's 10 s x 8.
5. Route by the envelope's current code when the tool argument is a retired code (this spec: yes).
6. D7 (fix the Generation Log crash window in localAiApplication.js) now matters more with an unattended model loop; schedule it with release one or accept the wedge risk?
7. Application depth-first versus push-first at job boundaries under D4 (this spec: push first at boundaries only, burst limit owned by the push slice).

## Files

- `electron/ipc/handoffBridge/constants.js`: New. One frozen object of every limit in spec 4.4 (GET_HOLD_MS 20000, MAX_CONSECUTIVE_WAITS 10, MAX_RESPONSE_BYTES 1000000, budgets, caps, TTLs), unit in each name.
- `electron/ipc/handoffBridge/engine.js`: New, pure with injected clock/sources/store/audit. Epoch fence, lane registry, depth-first scheduler, get(), submit() pipeline, hint(), release/unrelease/hold/resume/newChat, status snapshot builder, verdict cache, budgets.
- `electron/ipc/handoffBridge/lanes.js`: New, pure. Lane factory, phase state machine (6.1-6.3), code index, tombstones, counters, human-advance detection via issuedCodes.
- `electron/ipc/handoffBridge/preflight.js`: New, pure (node:crypto only). classifySubmission, extractEnvelopeIdentity (regex port of pasteIdentityGuard.js:98-126), trimHandoffCode, responseFingerprint (cyrb53 port, pasteIdentityGuard.js:35-70), fence regex identical to localAiApplication.js:825.
- `electron/ipc/handoffBridge/framing.js`: New, pure. Tool-result body builders (served/waiting/paused/queue_empty/session_full/accepted/rejected and the fixed-status set), correction clipping and path scrubbing, starter and continue message builders.
- `electron/ipc/handoffBridge/errors.js`: New, pure. Fixed-sentence table by code/enum and classifyThrow(err) that reads only error.code.
- `electron/ipc/handoffBridge/store.js`: New, fs. lanes.json, epoch.json, state.json (0600, dir 0700, tmp+rename, one serialized write chain, version 1, unknown version = empty). Shared with the OAuth slice.
- `electron/ipc/handoffBridge/sources/application.js`: New. The only importer of localAiApplication.js and only getLocalApplicationHandoff, submitLocalApplicationHandoff, localApplicationStatus; read/status/submit adapters with 8 s single-flight watchdog, status mapping table 6.2, throw classification by error.code.
- `electron/ipc/handoffBridge/index.js`: New. registerHandoffBridgeHandlers({ notify, getCanvasWindows }), startHandoffBridge(), stopHandoffBridge(), the ten IPC channels in 12.1 (plain ipcMain.handle with try/catch), native dialog and clipboard ports (optional-chained), status broadcast, E2E/packaged/env gating.
- `electron/ipc/handoffBridge/audit.js`: New. Metadata-only ledger with the application event vocabulary in section 11, including host_duration for tuning the wait cap.
- `electron/main.js`: Additive: import near :24; registerHandoffBridgeHandlers + fire-and-forget startHandoffBridge in a try/catch after registerNonApiAiHandlers() at :1178; stopHandoffBridge() as a fourth entry of the production Promise.allSettled at :1361-1365. No change to the pinned background-E2E quit block.
- `electron/preload.js`: Additive after :196: handoffBridgeGetStatus/SetEnabled/SetAutoRelease/Release/Unrelease/Hold/Resume/NewChat/ContinueMessage/Hint plus onHandoffBridgeStatus and onHandoffBridgeApplicationChanged via createListener (:7-13).
- `src/components/HandoffBridgePanel.jsx`: New. Pill and popover: release checklist from subscribeApplicationHandoffs, per-lane state, Take over/Resume, New chat, hint emission, application-changed -> requestApplicationHandoffRefresh. Inline useRef/useState, hooks above early returns.
- `src/utils/handoffBridgeQueue.js`: New, pure. Maps dock items to bridge states, strips prompt/code/draft/corrections, builds the change signature used for hints.
- `src/App.jsx`: One import and one <HandoffBridgePanel /> element after <NonApiAiDialog /> (App.jsx:34).
- `scripts/test-runner.js`: Register handoff-bridge.js, handoff-bridge-preflight.js, handoff-bridge-application.js, handoff-bridge-source-scan.js and the pure handoffBridgeQueue test with unique names.
- `electron/ipc/localAiApplication.js, src/components/NonApiAiDialog.jsx, src/hooks/useApplicationHandoffDock.js, src/utils/applicationHandoffDock.js, src/nodes/JobCardNode.jsx, src/hooks/useLocalAiFallbackManager.js`: NO CHANGE. git diff --stat must show zero lines; enforced by handoff-bridge-source-scan.js.

## Tests

- Routing: code index hit; tombstone accepted -> duplicate; tombstone rotated/moved -> superseded; index miss with the envelope naming the current code of the jobId's lane -> routed with the corrected argument; otherwise unknown_handoff.
- Preflight table: '', whitespace, '{}', '[]', 63-char no-brace, non-object JSON, each of jobId/stage/handoffCode missing -> junk with no app call; other lane's jobId, unknown jobId, and regex-extracted jobId on an unparseable answer -> misrouted; wrong stage -> superseded; fingerprint match only against a DIFFERENT lane's accepted text; patches delta passes; 30 KB syntax-broken text passes to the app; size cap is UTF-8 bytes (multibyte string just over 1,000,000 bytes but under 1,000,000 chars -> too_large).
- Parity proof (real app functions): a '{}' and a wrong-job submit leave Paste Rejections.json, Paste Correction Items.json and getPasteHandoffDiagnosticsSnapshot() byte-unchanged, while the same answers sent straight to submitLocalApplicationHandoff would change them.
- Serve fidelity: bridge get returns handoff.prompt byte-for-byte equal to getLocalApplicationHandoff; never contains draft, folder, localJob, jobId outside the prompt, canvasFilePath, labels or error text.
- Correction serve modes: same-chat rejection and measured-fit reopen carry prompt + corrections + correctionPrompt; first serve in a fresh epoch or after _resetPasteCorrectionsForTests (recovered) carries prompt + corrections + note and NO correctionPrompt.
- Accept/reject/rotate: accept returns the next stage inline with a rotated code; schema-invalid rejection keeps the SAME code; completion-time host rejection returns the NEW code and tombstones the old as rotated; jobComplete accept puts the lane in host and never yields queue_empty for that lane.
- Throw table: stale argument code (human advanced) -> re-read; same stage new code -> exactly one retry with the fresh code; different stage -> superseded and human_advance hold; integrity fault (isJobIntegrityFault) -> fixed sentence, no path or observation text anywhere; fs fault carrying /Users/... in its message never appears in any result, log or audit line; crash gap (log append succeeds, manifest write fails) -> identical-bytes resubmit recovers, different bytes -> retry/needs_user.
- Verdict cache: an identical retry within 60 s does not call the source a second time and does not bump the rejection streak; the HTTP-facing call returns retry at 25 s while the app promise continues and a later identical call attaches and returns the real verdict; client abort cancels holds but never an app call.
- Scheduler and statuses: depth-first across three lanes; a host lane never blocks an awaiting lane; get is idempotent (serves counter only); waiting -> paused after 10 consecutive waits and the counter resets after a 90 s gap; queue_empty only when every lane is done/gone (never for unread, host, held, needs_user, or an empty publish); session_full at a job boundary at the soft budget and mid-job at the hard budget.
- Human vs bridge: dock-path accept while a bridge submit is in flight serializes on the per-job lock and the loser is superseded; a code not in issuedCodes on an awaiting lane -> held('human_advance'); bridge's own accepts never self-hold; a same-code corrections change (dock rejection) is adopted, not held; draftBytes surfaces as an observation only.
- Caps: 6 rejections per job including rotated-code ones, 5 consecutive junk/misrouted, 8 revised review rounds, 3 consecutive read/commit errors each hold or needs_user with the right ReasonCode; counters reset on an accepted non-final stage; resume clears the cause.
- Persistence: lanes.json/epoch.json round trip with 0600/0700 modes and version guard; holds are durable before hold() returns; startup rehydration makes no app call and marks lanes unread except held/needs_user; the raw chat key never appears in any file (grep the store directory for the plaintext key); an open chat's key still authenticates after a simulated restart; retired keys return session_ended.
- Mid-import lane: hold the per-job lock with a pending promise; get answers busy within 8 s, serves another awaiting lane, and the queued read settles later without a duplicate read (single-flight).
- Membership: release validation (uuid regex, absolute path, 60-char label, max 10, dedupe), native confirm required for origin 'user', autoRelease honored only when enabled, unrelease waits for the in-flight promise, add-only stream survives the dock publishing [] on unmount.
- Renderer contract: application-changed reaches every canvas window; the panel's hint signature equals the dock's correctionSignature construction; a hint that changes nothing emits no event (loop freedom).
- Sentinel privacy run: full scripted session with a capturing logger; assert no prompt, response, handoff code, chat key, job id, canvas path or label in any log line, status payload, audit line or IPC return.
- Source scan and zero-diff: only sources/application.js imports localAiApplication.js and only the three names; no nonApiAi.js import; no .message/.stack/req.url in log calls; pre-auth files import only node:http/node:crypto/siblings; git diff --stat is zero for the six app files; main.js hunks additive and the pinned E2E quit regex (electron-regressions.js:115) still matches.
- Drift guards: MAX_RESPONSE_BYTES equals localAiApplication.js:58; preflight fence regex equals :825; trimHandoffCode and responseFingerprint agree with the real pasteIdentityGuard.js on a corpus.
- Manual gates (no component test exists): two or more pending handoffs with a live linked chat; human paste and Take over mid-session; a host lane completing with the canvas open and again with every canvas window closed (expect host_silent needs_user after 10 min, never a false queue_empty); app restart mid-chat; packaged .app launched from Finder.

## Risks

- Renderer-driven completion is the main external dependency: a bridge chat can only drain to paste-completed. Import, PDF fit and measured-fit reopen need a mounted canvas and renderer timers (poll 2.5 s, settle 6 s, then render). With always-armed and all windows closed (macOS keeps the app alive), host lanes stall silently until host_silent at 10 min. Renderer throttling under a frontmost ChatGPT is still unmeasured (E5).
- Wait-cap sizing is a guess: 20 s x 10 (about 3.3 min) versus an unmeasured import duration distribution. Too low pauses the chat mid-import (Jack must send Continue); too high burns tool calls against an unmeasured per-reply ceiling. The audit ledger records host_duration so this can be tuned after the first real runs.
- Corrections serve rule (delta only when the epoch holds the stage prompt) is my derivation from the dock's own behavior and the app's delta wording; the spike only exercised full prompt plus corrections plus correctionPrompt together. The rule is safe (never sends a delta to a chat without context) but the fresh-chat and recovered forms are untested against ChatGPT.
- Idempotent gets re-send 20-65 KB prompts (the model called get 3-8 times per chat in the spike). Every repeat counts against the epoch budget, so soft/hard budgets will trip earlier than a naive per-stage estimate; budgets are provisional.
- Crash window (Generation Log append at :4326 before manifest write at :4328): identical-bytes retention is memory only; a restart between the throw and the retry, followed by a re-written answer, wedges the stage (:3545) until D7 is fixed in the app.
- readOnlyHint:true on get_handoff misdescribes a call that can end a job or rewrite the manifest (:3699-3711, :3770-3772, :3853-3855); already flagged in design section 17. The chat key compensates but the annotation is still wrong; Phase 0 E8 did not run.
- Bridge preflight duplicates two app behaviors (fence regex, 1,000,000-byte cap) and one renderer behavior (fingerprint); drift is caught only by the source-text and corpus tests, which are themselves raw-substring assertions like the 82 existing ones.
- Diagnostics attribution: recordPasteHandoffDiagnostic has no transport field and cannot be tagged without editing localAiApplication.js, so bug reports cannot distinguish bridge rounds from pastes except through the bridge's own audit ledger (design D10 telemetry).
- Multiple canvas windows: each window has its own dock store and its own panel; main state is global. Events must broadcast to all windows, and a release from one window for a job on another window's canvas is valid because the app verifies manifest ownership, not window ownership.
- Human and bridge on one job can still waste generation: the paste box is never disabled, a bridge accept unlinks paste-draft.json (:4323), and the dock overwrites its textarea from disk when the code changes (NonApiAiDialog.jsx:895-905). Auto-hold reduces but cannot prevent it.
- Two chats sharing one key (starter pasted twice without New chat) are indistinguishable to the server; only the 'served N times without a submit' observation reveals it.
- Preflight can misclassify a legitimate but unusual answer as junk (envelope key missing) and increment the junk streak; mitigated by a specific note, the 5-junk cap that hands the lane to Jack, and the fact that the dock path still accepts anything the app accepts.
- ChatGPT's safety layer blocked one review-stage submit twice after a reconnect; the server cannot observe a block. The lane simply shows 'served at T, no submit since'; recovery is Continue in the same chat or New chat, both resume from get_handoff alone.

## Open questions for Jack

- Release model under D5: should Jack explicitly release each job (one native confirm per batch, default in this spec) or should a persisted 'auto-release every new application bundle' toggle exist (one native confirm when he turns it on)? It changes the consent boundary but not the code.
- Should released jobs stay released across app restarts as standing consent (this spec) or be re-confirmed at every launch?
- Is it acceptable to persist a SHA-256 hash of the chat key so an already-open ChatGPT chat keeps working after the app restarts? The cost is that 'Copy continue message' cannot be regenerated until he presses New chat.
- Are 20 s holds and 10 consecutive waits (about 3.3 min) acceptable in place of the design's 10 s and 8, until real import durations are measured?
- Should the bridge route a submit by the envelope's current handoffCode when the tool argument is a retired code from the same job? This tolerates a copy slip but deliberately does not enforce the argument.
- D7 (making the Generation Log append recoverable when manifest.logCount is behind the log tail) is an edit to localAiApplication.js. With an unattended model loop it is more likely to bite; do you want it scheduled with release one instead of Phase 2?
- With D4 in release one, at a job boundary should push (scoring) handoffs be served before application handoffs (mirrors the dock's mergeDockQueue), and how large a push burst may starve waiting application jobs?
