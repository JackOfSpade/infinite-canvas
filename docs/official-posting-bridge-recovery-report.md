# Official posting bridge recovery

## Root cause and evidence limits

The confirmed reporting bug was in `officialPostingService.js`: `failureCode()` reduced most exceptions to `research-miss`, and both comparative catch paths converted that result to `comparative-invalid`. A transport exception or programming error therefore looked like a rejected judge response. Explicit failures from the inner `cappedHandoff` controller could also lose their classification when the outer operation signal was still live.

The original generic batch-rejection path was `nonApiAi.js` → `sendRequest()` → `send()` returning false → `abortPending(new Error(...))` → the original request promise rejecting. One failed dock replay/delivery pass could reject several pending requests in the same synchronous turn. The first recovery change only classified that failure as `BRIDGE_RENDERER_UNAVAILABLE`; the delivery follow-up below removes the terminal behavior for MCP work and transient manual presentation failures.

The early `bridge-aborted` batch followed the shared parent operation signal: queued handoffs reject in the service's `onAbort`, admitted handoffs receive the reason through `cappedHandoff`'s abort relay, and registry requests reject through their abort listeners. IPC renderer destruction, renderer-process loss and navigation previously supplied generic errors. The first change classified those causes; the follow-up also prevents display-only lifecycle loss from aborting MCP operations. Genuine parent cancellation remains terminal.

The current source does **not** prove that worker diagnosis caused either live batch. Before this change, `restartWorker()` preserved source ownership; restart-cap hand-back and contaminated-B submission instead rejected comparisons with the already coded `OFFICIAL_POSTING_COMPARATIVE_UNAVAILABLE`. Also, `push.get()` normally allows only one outstanding served/reserved request per worker. Tests therefore cover real simultaneous reservations across workers and an engine fixture with several claims belonging to one worker. The old reduced logs cannot identify the actual originating event at either supplied timestamp.

## Recovery changes

- Worker replacement synchronously releases every served/reserved push claim through `push.requeueWorker()`, including reservations absent from the worker's `activeTask` roster.
- `requeueBridgeableNonApiAiHandoff()` keeps the same request, handoff code, owner promise and validation correction count. It clears the comparative proof and permits at most two recoveries. The third rejects with `BRIDGE_REQUEUE_EXHAUSTED` and a closed `recoveryCode` identifying worker loss, replacement, contamination or required fresh context.
- Contaminated B submissions and reads requeue instead of failing the comparison. The old conversation is barred, including after comparison-history eviction. The engine returns `session_full` and requests a fresh worker conversation.
- Requeue does not redeliver through the dock, recreate the caller invocation, or reset assignment. The existing unassigned deadline remains active until first assignment; the original response deadline continues after assignment. Cancellation cannot resurrect a request. Validation failures retain their separate one-correction budget.
- Old prompt reads cannot remove, requeue or overwrite replacement ownership. Stale discovery results cannot erase newly created or extended conversation fences.

## Dock delivery follow-up — 2026-10-30

The terminal mistake was treating dock presentation as the transport for every request. MCP workers read and submit through the main-process registry, so rejecting their owner promises on a dock send failure destroyed otherwise serviceable comparisons. Two additional lifecycle paths mattered: `ipcUtils` unconditionally aborted operations on renderer navigation/process loss/destruction, and the Board refresh hook plus Board unmount cleanup cancelled refreshes when nested navigation hid their React instances.

- Failed initial, replay and correction delivery now preserve MCP requests. Transient manual send failures are also retained. Presentation retries use exponential backoff from 250 ms to a 30-second cap; `dom-ready`, dock remount, focus, pageshow and visible recovery re-present pending work. Retries preserve request/code identity, worker claims, comparison proof, correction budgets, assignment and existing deadlines. Settlement/cancellation removes timers and listeners.
- A manual transport failure is terminal only on confirmed originating renderer destruction or process loss. A failed send or a zero process ID during renderer startup alone is insufficient. Manual terminal delivery/admission uses `BRIDGE_RENDERER_UNAVAILABLE`; actual lifecycle signals retain `IPC_SENDER_DESTROYED` / `IPC_RENDERER_STOPPED`. Genuine cancellation, timeout, validation and worker recovery limits keep their existing behavior.
- IPC handoff retention begins before asynchronous durable admission and lasts for the invocation, covering gaps between comparisons. MCP work survives navigation, process loss and window destruction, remains registered for explicit cancellation/quit drain, and can complete its original promise. Per-request manual lifecycle handling covers mixed MCP/manual workflows, late manual admission and attachment hand-back after renderer loss.
- Push retains only an already selected, main-verified window/node/path scope when its display window disappears. Missing windows cannot authorize new hubs. Live file-path changes and explicit unselection/clearing still revoke scope.
- The dock is an App sibling outside the canvas tree. Minimize/expand, Jobs/Sell/Stats transitions and nested navigation do not trigger a dock replay or remove its listeners. Actual remount replay remains keyed by request ID; repeated saved-draft delivery also preserves the person's current selection. Overlapping recovery invokes are coalesced.
- Board refresh now reads all retained canvas nodes/edges and applies results globally while the Board is hidden in a nested canvas. Its hook and broader Board unmount cleanup retain an active same-file refresh. Explicit cancellation, deleted owners and replaced files retain their ownership checks and cancellation behavior.

The regressions reproduce the failure mechanism and the UI lifetimes; the old reduced logs still do not identify the exact renderer event at the original live timestamps. No app or Electron process was launched to reproduce them.

## Diagnostics

Judgment `failure` and discovery `failureCodes` use closed classes for validation, worker loss/replacement, contamination, fresh context, exhausted recovery, renderer lifecycle cancellation and unexpected JavaScript error classes. Exhaustion also records its closed `failureCause`. Arbitrary exception messages/codes, prompts and response content are excluded from these new fields. Generic exceptions no longer become `comparative-invalid`.

Relevant implementation: `electron/ipc/nonApiAi.js`, `electron/ipc/handoffBridge/sources/push.js`, `electron/ipc/handoffBridge/engine.js`, `electron/ipc/ipcUtils.js`, `electron/ipc/officialPostingService.js`, and `electron/ipc/officialPostingDiscoveryDiagnostics.js`.

## Prior recovery validation

All suites were invoked directly under Node with `scripts/test-stubs/register.mjs`; no app build or Electron process was run.

- Sweep: all `official-posting*` and `handoff-bridge*` suites, `job-board-official-posting-refresh`, `non-api-ai`, `non-api-ai-bridge-seam`, and the LLM/model suite `ai-models`: 84 suites, initially 2,311 passing and four sandbox-blocked cases.
- All four blocked cases attempted `/bin/ps` for authority-ledger process identity and received `spawn EPERM`. Both affected suites were rerun using the existing `__setAuthorityLedgerProcessIdentityHookForTests` seam: 12/12 passed. No production authority-ledger changes were made.
- Six additional stale-read/discovery race regressions were then added; the complete push suite passed 138/138. This brings unique coverage in the requested sweep to 2,321 cases, passing with the noted process-identity test hook for the two affected suites.
- Recovery coverage includes simultaneous reserved handoffs completing their original promises on a replacement, contaminated B completing in a fresh conversation, bounded recovery, cancellation, assignment remaining one-shot, validation exhaustion surviving recovery, coded simultaneous delivery failure and shared parent cancellation.
- `npm run lint` and `git diff --check` passed.

The existing uncommitted tree was preserved. No commit, build, relaunch, Electron run, or access to the prohibited application-data and Job Search directories was performed.

## Delivery follow-up validation

Suites were imported and their test cases invoked directly using plain Node with `--import ./scripts/test-stubs/register.mjs`. The temporary runner `/private/tmp/ic-dock-delivery-direct-suites.mjs` guards unexpected network calls; the Electron stub uses a process-private temporary user-data directory. The app, Electron and builds were not run.

- All `official-posting*`, `job-board-official-posting-refresh` and `ai-models`: 63 suites, 891 cases at the first sweep. Four process-identity cases encountered the existing `/bin/ps` sandbox restriction; both affected suites (`official-posting-freeze`, `official-posting-r1-legacy-binding`) then passed all 12 cases using `__setAuthorityLedgerProcessIdentityHookForTests`. No production ledger code changed.
- Final affected sweep: every `handoff-bridge*` and `non-api-ai*` suite, plus `electron-regressions`, `job-board-official-posting-refresh` and `career-recovery-resume`: 24 suites, 1,538/1,538 passed. This includes the final push 140/140, dock render 27/27, registry 106/106, IPC lifecycle 53/53 and Board refresh 25/25.
- Additional IPC coverage: `job-diagnostics`, `job-analysis-operation-ledger`, `job-analysis-operation-authority-adversarial`, `solve-ipc-failure`: 390/390 passed.
- Unique final coverage across those runs: 90 suites, 2,795 cases passed, counting overlapping suites once and using their final case counts.
- `npm run lint` and `git diff --check` passed against the final changes.
- Regressions cover five original MCP comparison promises completing through push after a failed replay, repeated remount, navigation, process loss and actual display-window removal; transient delivery retry on both routes; admission-time renderer loss; mixed transports; dead-renderer manual hand-back; recovery during renderer startup; explicit cancellation; and global result application across real nested canvas navigation.

All pre-existing changes were preserved, and interview files were left untouched by this work. No commit or access to the prohibited application-data or Job Search directories was performed.

## Reload adoption and cancellation regression — 2026-10-30

The independent review confirmed a gap in the delivery follow-up. `ipcUtils` deliberately retained admitted handoffs on reload, but `requestNonApiAi` still treated each resumed invocation as a new request. Durable identity was only a checkpoint lookup, not a live ownership constraint. Resuming the same `(manualAiRunId, stepKey)` therefore allocated a second request/code and could serve two workers. Its later pending/accepted writes could replace the first answer. Separately, node cancellation searched only the current sender's task registry, leaving a retained owner in an old window unreachable.

Changes:

- A process-local owner keyed by run and durable step is reserved **before the first asynchronous durable read**, retained through admission and acceptance, and removed on settlement or admission failure. Exact legacy/raw aliases converge on the same owner before code allocation or writes. A resumed invocation adopts the existing request's shared result instead of creating a second record. This also covers concurrent initial invocations and resume during an accepted-answer save.
- Adoption retains the request ID, handoff code, worker claim, comparison provenance, validation contract, correction state, assignment and deadlines. Each attached caller receives assignment notification once and shares the one terminal answer/error. Adopted abort listeners are removed on settlement. A second submission during save is busy; submissions after acceptance are no longer pending and cannot overwrite the saved answer.
- Dock presentation can move to the new renderer without changing the original main-verified bridge window/node scope. This preserves an already served worker's permission to submit its late answer and prevents another worker from receiving the same step. Replay, draft, Copy, Reveal and Cancel ownership use the adopted presentation sender.
- Node cancellation now discovers retained MCP owners across senders by node and known run IDs. Before auto-resume supplies a local run, it also reaches orphaned MCP owners whose renderer has stopped, navigated or been destroyed; unrelated live canvases with matching node IDs remain isolated. Acknowledged cancellation drains every matched handler and returns its retained run IDs. The preload/network cancellation APIs accept an optional exact run ID/list, and dock Cancel explicitly supplies its record's run ID.
- Navigation is tracked separately from confirmed renderer loss. This allows orphan discovery during reload while keeping an existing manual handoff replayable through a temporary navigation gap.

Validation used plain Node with `scripts/test-stubs/register.mjs`, an unexpected-network guard and process-private temporary user data. No app or Electron process was launched.

- The supplied `/tmp/bridge-dup-repro.mjs` now reports two invocations with **one pending record and one handoff code** after main-frame navigation and resume.
- All requested `official-posting*`, `handoff-bridge*`, `non-api-ai*`, `job-autoresume*`, IPC (`electron-regressions`, `handoff-bridge-ipc`, `solve-ipc-failure`) and `claude-application-runner` suites passed directly. Board refresh and career recovery suites also passed: **89 suites, 2,477 cases, zero failures**. Authority-ledger fixtures used their existing process-identity test hook for the sandbox's `/bin/ps` restriction.
- Six new registry tests cover same-window reload, replacement-window adoption with the original push claim, one serve across workers, both callers receiving one answer, concurrent durable admission, adoption during save, assignment fan-out, rejected late duplicate answers preserving durable content, orphan cancellation and Cancel from the new window. Three IPC regressions cover orphan cancellation, cross-sender draining and exact-run cancellation before resume.
- `npm run lint` was run twice. The final run reports one unrelated interview error: an unnecessary escape in `electron/ipc/interviewSpokenClaims.js:95` (`no-useless-escape`). The earlier run also reported five unused imports in `electron/ipc/interviewAnswerBank.js`; concurrent workspace edits removed those findings before the final lint run. Both interview files were left unchanged by this work. ESLint passed for every file changed for this regression; `git diff --check` also passed.

All existing uncommitted work was preserved. No commit, app/Electron launch, or access to the prohibited application-data and Job Search directories was performed. The private application-improvement counter was not inspected because it resides in the explicitly prohibited application-data directory.

## Cancellation diagnostics assertion correction — 2026-10-30

The reported `job-diagnostics` failure was reproduced directly: 319/320 cases passed, with the failure at the renderer-cause assertion. That assertion required the exact old two-argument preload declaration and three-argument `abortNodeTasks` call. Both source strings changed when optional run IDs were added for retained work across senders. The assertion therefore rejected a backward-compatible API extension; it did not establish that the cancellation cause had been lost.

The production path still forwards `cause` through `nodeCancellationError(cause)` to the matched controllers without replacing the reason. `jobs.js` still resolves `reason.cancelCause` through `CANCEL_CAUSE_LABELS` for reporting. No production change was needed. The exact `Node deleted` message, `AbortError` name, diagnostic label assertions and cross-sender node/run matching remain intact.

The two obsolete source-string checks in `scripts/tests/job-diagnostics.js` were replaced with behavioral coverage of the exposed preload API, registered network handlers and real task registry. Ten scenarios exercise both fire-and-forget and acknowledged cancellation for local work, adopted owners, explicit string/list run IDs and an orphan after navigation. They check the original renderer cause, exact sentinel, unrelated-live-run isolation, caller-visible errors and acknowledged cleanup/run identity. Separate memory-only fault injections dropping the cause from each preload route both make the new assertion fail.

Validation used plain Node with the Electron test stub, an unexpected-network guard and temporary user data:

- All 44 `job-*` suites, including `job-diagnostics` (320/320), plus `electron-regressions` and `solve-ipc-failure`: 46 suites, 1,101 cases passed.
- All `official-posting*`, `handoff-bridge*` and `non-api-ai*`: 83 suites, 2,291 unique cases passed. Four initial `/bin/ps` sandbox failures were rerun through the existing process-identity test hook; the two affected suites (`official-posting-freeze`, `official-posting-r1-legacy-binding`) passed all 12 cases. Combined coverage: **129 suites, 3,392 cases passed**.
- Targeted ESLint for the changed test and `git diff --check` passed. Full `npm run lint` failed on the concurrent interview work: `electron/ipc/interviewSpokenClaims.js:139`, unused `agencyWords` (`no-unused-vars`); that file was left untouched.

All pre-existing changes were preserved. No interview file edits, commit, app/Electron launch, or access to the prohibited directories was performed.
