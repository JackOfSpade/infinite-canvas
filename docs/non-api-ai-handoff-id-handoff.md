# Handoff: per-handoff unique identifier + paste-time verification

**For:** Codex, working in `/Users/jack/Desktop/My Apps/infinite-canvas`.
**Status (current):** implemented and verified in the current working diff. The investigation below is retained as historical context for why the change was needed.

- HANDOFF codes now identify each copy/paste request and are checked when a response is pasted.
- Fresh `job-preference-evaluation` responses must return each row's opaque per-listing `listingId`; this closes the positional-only identity gap. Previously accepted v1 durable responses have a restricted exact-contract replay path so they can be consumed without weakening fresh requests.
- The exact historical snapshot recovered batch 38 (jobs 326–333) and batch 39 (jobs 334–341). The duplicated response belonged to batch 38, so batch 39 was the incorrect acceptance.
- The user authorized a rerun. Both exact batches were freshly evaluated against all 32 preferences and installed as legacy v1 rows after validation against the recovered eight-listing slices/local indexes, all 32 preference IDs, and verbatim evidence quotes.
- The atomic repair completed at `2026-09-17T20:05:13.808Z`. The live durable file and its backup are mode `0600`; no accepted durable response bodies are duplicated.
- Durable prompt identity now canonicalizes generated untrusted-content boundary nonces before hashing, preserving durable-step reuse while keeping the actual prompt boundaries unpredictable.

---

## 1. What the user asked for

> "these handoff calls should have a unique identifier at the top so when i'm doing multiple, i don't get confused and paste the wrong one."
> "add verification so that the paste has the matching unique identifier. it will be backwards compatible because it is only checked at paste time."

Two deliverables:

1. A short, human-legible unique code per Non-API AI handoff, visible **at the top of the copied prompt** and mirrored in the dialog UI.
2. **Paste-time verification** that the pasted response carries the *same* code, rejecting a mismatch.

The backwards-compatibility argument the user gave is correct and is a binding design constraint — see §4.

---

## 2. Why this is urgent: the wrong paste already landed, silently

This is not a hypothetical ergonomics request. Evidence from bug report `bug-report-2026-09-17T17-40-58-570Z.md`:

**Handoff lifecycle** — 20 retained handoffs of task `job-preference-evaluation`, node `…3e46a4ec`, all 8 items each. Response sizes across the batches: 39834, 48386, 50248, 42383, 64965, 42432, 39959, 48592, 40410, 41750, 40183, 47492, 39918, 47298, 49360, 52482, **29559**, **29559**, 36357.

- batch 38 — prompt 30650 chars → response **29559** chars → accepted
- batch 39 — prompt 39038 chars → response **29559** chars → accepted

Different prompts, byte-identical response size. **Event log** confirms it directly:

```
13:35:44.381  PASTE: types=[text/plain,text/html] textLength=29559
13:36:10.582  [Focus] textarea "Paste the full response here…" (×3)
13:37:19.225  PASTE: types=[text/plain,text/html] textLength=29559
```

The same AI response was pasted into two different handoffs 95 seconds apart, and **both were accepted with zero rejections**. One batch of 8 jobs now carries another batch's preference evaluations.

**Why nothing caught it at the time** — the then-current `validateJobPreferenceListingSubmission` identified listings by **positional `row.index` in `[0, jobs.length)`**, and validated `preferenceId` against `expectedIds`, a set derived from the run-wide preference plan that was *identical for every batch in the run*. Every 8-item batch therefore produced a response with indexes 0–7 and the same preference ids. Batch 38's response was a perfect structural match for batch 39's request. There was no listing id, URL, or batch token in the schema or validator.

Contrast `validateJobPreferenceResearchSubmission` (same file, 814-822), which *does* hard-check `row.preferenceId !== preferenceId`. The listing path simply lacks an identity axis.

The transport guard now protects all task ids, and `job-preference-evaluation` also has a task-level identity check for fresh responses. The latter closes the same-size, same-preference-plan gap even if a response has no handoff code.

---

## 3. Verified facts you can build on (don't re-derive these)

### Transport
- `electron/ipc/nonApiAi.js` is the Non-API AI transport (`project_all_ai_via_copypaste_handoff`). `materializeNonApiPrompt` is materialized from `requestNonApiAi`; renderer code does not call it directly.
- `electron/ipc/llm.js` reaches `requestNonApiAi` through `callLLMText`, `callLLMRaw`, `callLLMVision`, and `callLLMDocument`.
- A validation-failure reissue keeps its request id. A step-back reissue driven by `runRewindableGroundedHandoff` mints a new request id while resolving the same logical durable step.

### Durable steps — current compatibility behavior
`durableStepKey` hashes the complete logical prompt plus task, node, batch, item count, and normalized attachment paths. The implementation builds the durable lookup prompt before adding the transport-only handoff header, so adding a handoff code does not orphan a pre-change accepted step.

`wrapUntrustedText` deliberately places a random nonce in each copied prompt boundary. `canonicalizeGeneratedUntrustedBoundaryNonces` canonicalizes only boundaries that carry the app's exact explanatory header before computing the logical durable key; the copied prompt keeps its random boundary. Lookup also accepts the exact historical raw key. This preserves durable reuse across regenerated random boundaries without treating a user-supplied tag-shaped string as scaffolding.

For the listing-evaluation migration, current v2 lookup is always attempted first. Only when no v2 step exists may the code inspect a v1 alias, and then only for a uniquely matching **accepted** step with the exact historical v1 contract. The alias preserves either the older fixed `batchTotal` metadata or a recalled adaptive layout's explicit `batchTotal: null`; it never substitutes a newly computed total. Pending, invalid, ambiguous, and v2 responses are never downgraded to positional replay.

### Schemas
- Production top-level response schemas are object-rooted. The transport injects its `handoffCode` property only into a rendered object-schema copy, and guards that path accordingly.
- `assertResponseMatchesSchema` (`electron/ipc/schemaValidation.js`) enforces `enum` and `const`, and rejects extra properties only when a schema sets `additionalProperties: false`. The transport strips its own `handoffCode` before task code sees a structured response.
- `canonicalizeResponseSchemaEnums` is purely functional (never mutates input).
- `parseAiJson` (`electron/ipc/jsonRepair.js`) strips ```` ``` ````/```` ```json ```` fences, tolerates leading/trailing prose via a first-to-last brace/bracket span, strips trailing commas, and has **no comment stripping**. Do not put the code in a JSON comment.
- **Free-text handoffs (no `responseSchema`) exist — exactly 3 production call sites**, all `callLLMRaw` with `grounding: true`, feeding prose into a later schema-validated extraction:
  - `electron/ipc/jobs.js:5725` (`job-compensation-research`)
  - `electron/ipc/jobs.js:6084` (`job-compensation-research`)
  - `electron/ipc/jobPreferences.js:894` (`job-preference-research`)

  `validateNonApiAiSubmission` skips `parseAiJson` and schema assertion entirely when `responseSchema` is absent; the raw string is returned as-is.

### Renderer
- `src/components/NonApiAiDialog.jsx` is the Tailwind, portal-rendered global dock mounted from `src/App.jsx`. It shows the active `HANDOFF-XXXXXX` badge in the header; pending selectors show only their batch number or queue position.
- Its validation-error alert renders the main-process rejection and its draft scan warns before submission when a pasted handoff code belongs to another request.
- `publicRequest()` exposes `handoffCode`; `electron/preload.js` forwards the generic request payload without a field whitelist.
- `src/nodes/JobSearchNode.jsx` / `JobBoardNode.jsx` only listen for `non-api-ai-node-pending` / `non-api-ai-node-cancelled` DOM events to write a hidden `manualAiResume` marker. Both carry the comment "The global handoff dialog owns the pending request UI." **Do not add handoff UI to the nodes.**

### React Compiler
`src/` runs the React Compiler (`project_react_compiler_enabled`). Do not extract inline `useRef`/`useState` stable refs into custom hooks.

---

## 4. Implemented design

### 4.1 The code

The implementation derives the code deterministically, so a resumed run shows the **same** code the user already pasted into their chat.

```js
// sha256 over the same logical inputs as durableStepKey, but computed
// unconditionally (durableStepKey is only built when runId is present).
const HANDOFF_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I/L
```

- **Length 6** from that 32-char alphabet (~1.07e9 space). Concurrent pending handoffs peak around 40; collision probability is negligible.
- Render everywhere as `HANDOFF-XXXXXX` — the `HANDOFF-` prefix is what makes the paste-time regex scan safe (see §4.4).
- A uniqueness guard re-derives from the next six alphabet-mapped digest characters if the derived code belongs to a different live entry in `pendingRequests`.
- The record stores `handoffCode` and `publicRequest()` exposes it.

### 4.2 Where it appears

**In the prompt** — the user's literal ask is "at the top", so the implementation puts it in **both** places:

- A new **first line** of the materialized prompt, before `cachedPrefix`:
  ```
  === HANDOFF-K7Q3M2 · job-preference-evaluation · batch 36 of 259 ===
  ```
  There is no provider-side prompt caching on this transport (it's manual copy/paste), so breaking the shared prefix costs nothing.
- A `Handoff code: HANDOFF-K7Q3M2` line inside the existing `--- NON-API AI HANDOFF SETTINGS ---` block (`nonApiAi.js:588-597`), next to `Task:`.

**In the dialog** — a monospace badge is **always visible** (not gated on `multipleHubQueue`, unlike the Hub badge):
- It appears in the header beside the request title.
- The pending selector keeps the code in the header and prompt. Each visible button shows only its batch number, or its queue position when no batch is available. It is a 10-column grid on normal desktop viewports and five columns on narrow viewports, so ten concurrent prompts stay visible without horizontal scrolling; additional prompts wrap to new rows. Its `aria-label` and tooltip retain task, batch or position, owner, retry context, and status without the code.

### 4.3 Making the model echo it back

**Structured tasks (`responseSchema` present):** inject a transport `handoffCode` property into the schema **as rendered into the prompt only**. This does not prevent task-contract changes in `electron/ipc/aiSchemas.js`: listing evaluation v2 intentionally declares its required opaque `listingId` there.

- `materializeNonApiPrompt` builds the rendered transport copy:
  ```js
  { ...responseSchema,
    properties: { handoffCode: { type: 'string', const: code }, ...responseSchema.properties },
    required: ['handoffCode', ...(responseSchema.required || [])] }
  ```
  `handoffCode` first, so it lands at the top of the JSON block where the user can see it while copying.
- Guard: only when `responseSchema.type === 'object'` and `properties` is a plain object.
- The schema instruction requires `handoffCode` to be copied verbatim from the header and explains that it binds the answer to this request.
- The transport **strips `handoffCode` from the parsed value before returning it** to callers.

**Free-text tasks (3 call sites):** require a first line `Handoff: HANDOFF-XXXXXX`, then strip that line (and a single following blank line) from the returned string before handing it back. The strip is limited to an exact first-line match.

### 4.4 Paste-time verification — the backwards-compatible contract

This lives in **`validateNonApiAiSubmission`**, the pure seam shared by the IPC submit handler and tests. The expected code is threaded in as a parameter.

| Pasted response contains | Behaviour |
|---|---|
| a `HANDOFF-` code that **matches** | accept, strip the field/line, continue to existing validation |
| a `HANDOFF-` code that **differs** | **hard reject** — never reaches schema validation |
| **no** `HANDOFF-` code at all | **accept** — fall through to today's validation unchanged |

The absent case is what makes this backwards compatible and is exactly the user's reasoning: it is only ever checked at paste time, so no stored response, no durable step, and no historical data needs migrating. It also protects Jack's scarce resource — the handoff count (`feedback_prioritize_quality_over_cost`) — from being burned on a model that merely forgot a field.

**Detection must scan two channels, because a wrong paste may not carry the field in the place you expect:**

1. The parsed `value.handoffCode` (structured tasks).
2. A raw-text regex sweep of the pasted string: `/\bHANDOFF-([2-9A-HJ-NP-Z]{6})\b/g`.

Collect every distinct code found across both. If any differs from the expected one → reject. The `HANDOFF-` prefix plus the ambiguity-free alphabet is what keeps a job description from tripping this by accident.

The check runs **before** `parseAiJson` / `assertResponseMatchesSchema`, so the wrong-batch case produces the wrong-batch message rather than a schema-shape message.

**Error text.** The rejection names the observed and expected codes, states the consequence, and confirms that nothing partial was used. Its shape is:

> This response is stamped **HANDOFF-4F2A19**, but this prompt is **HANDOFF-K7Q3M2** — it is the answer to a different handoff. Nothing was saved. Find the chat whose prompt header reads HANDOFF-K7Q3M2 and paste that answer here. (Each prompt carries its own code precisely so two batches of the same task cannot be swapped.)

Per `project_diagnostics_assert_only_what_is_known`: this one *is* safe to assert, because a mismatched code is direct evidence, not an inference.

The renderer scans the draft and pre-warns before Submit; main-process validation remains the authority.

### 4.5 Bug-report reporting

Per `feedback_bugreport_workflow`, improve what the report can prove:

1. `createHandoffLifecycle` stores `handoffCode` for live/durable transport enforcement, but `buildNonApiAiHandoffLifecycleMarkdown` deliberately withholds it. Because the code is derived from the logical prompt, exporting it would let a report reader test guessed private prompts offline; the redacted request label and batch number provide report correlation instead.
2. The lifecycle stores a process-keyed response receipt tag: `responseHash` = the first 8 hex characters of `HMAC-SHA256(processRandomKey, response)`, alongside `responseChars`, and flags collisions in the report:
   > ⚠️ 2 handoffs accepted an identical response body (batch 38, batch 39) — the same answer was pasted into both.

   Today that condition is only inferable by eyeballing equal `responseChars`, which is how it was caught here. A process-keyed tag makes it provable and automatic within the lifecycle while preventing an exported report from becoming an offline membership oracle for guessed private responses. The key is memory-only and is never persisted or exported.
3. A lifecycle counter records code-mismatch rejections separately from other rejections.

**Filter code assessment:** no new bug-report filter code is needed. `FULL` already carried enough to diagnose this (lifecycle sizes + the PASTE event log). Items 1–3 are enrichments to existing sections, not new gated sections — consistent with `project_diagnostics_assert_only_what_is_known` ("new filter codes are never the fix").

---

## 5. Historical scope notes and current resolution

- The original investigation proposed leaving `validateJobPreferenceListingSubmission` positional because HANDOFF transport verification covered cross-request swaps. That deferral is superseded. Fresh `job-preference-evaluation` requests use `JOB_PREFERENCE_LISTING_EVALUATION_SCHEMA`, which requires `index`, opaque `listingId`, and `matches` for every row. The validator derives the expected IDs from the root batch and rejects missing, foreign, swapped, or duplicate IDs.
- `electron/ipc/aiSchemas.js` intentionally contains both listing contracts: v2 for all fresh requests and `JOB_PREFERENCE_LISTING_EVALUATION_V1_SCHEMA` solely for a restricted accepted-durable replay alias. The v1 validator rejects rows that carry `listingId`; fresh requests cannot select the v1 path. The transport's separate `handoffCode` remains a rendered-schema property and is stripped before task code consumes the response.
- The original investigation correctly avoided repairing the already-corrupted batch 38/39 data without authorization. That authorization was then given. The atomic repair completed at `2026-09-17T20:05:13.808Z`, after validation as v1 rows against the exact eight-listing slices/local indexes, all 32 preference IDs, and verbatim evidence quotes.
- The backup is `/Users/jack/Library/Application Support/infinite-canvas/non-api-ai-handoffs.before-batch-38-39-repair.2026-09-17T20-05-13-808Z.json`. It and the live durable file are mode `0600`. Batch 38 is accepted with SHA-256 `79e2b3d070ef07a99bef2b01280e28c4a6bba50df06e729be23fcb20dcb26ff8` and 114 confirmed / 12 conflicts / 130 unverified matches; batch 39 is accepted with SHA-256 `039a4c74b16da624d3b889e3062a8249bdd58d5886b8596340c441cee17b4167` and 117 / 13 / 126. Both contain 8 × 32 matches with quotes checked against the evaluated listing text. No accepted duplicate-response group remains.
- **Do not** add handoff UI to `JobSearchNode` / `JobBoardNode`.
- **Do not** commit or push (`feedback_no_commit_prompts`). Jack does version control manually.
- Jack may run a second agent in this repo concurrently (`feedback_concurrent_claude_instances`) — re-check `git status` before staging and never `git add -A`.

---

## 6. Tests

`scripts/tests/non-api-ai.js` now includes coverage for handoff codes, durable-key compatibility, v2 listing identity, and v1 accepted-durable replay. Verified blast radius:

- **Prompt header:** no test anchors on the prompt's first/last characters. One ordering assertion at line **351** (cachedPrefix before prompt) — a header prepended before `cachedPrefix` does not break it. ~40 plain `.includes()` / `!.includes()` checks.
  - ⚠️ Two **banned-substring** lists at lines **359-372** and **1301-1307** (`'"thinking"'`, `'"outputConfig"'`, `'Original API model setting:'`, `'must-not-leak'`, …). Your header text must not collide with them.
- **New `publicRequest` field:** zero tests do whole-object equality or `Object.keys(...).length` on the payload (the only `JSON.stringify` checks are scoped to `.attachments`, lines 639/669). Purely additive — safe.
- **Rendered-schema injection:** every `responseSchema` in this test file is a fresh inline literal; none imports a production schema. Fully insulated.

Coverage includes:

1. The code appears in the materialized prompt's first line **and** in the settings block.
2. The same logical request derives the **same** code twice (determinism / resume).
3. Two different batches of the same task derive **different** codes.
4. `durableStepKey` for a given input is **unchanged** by the feature — assert the literal hash before and after, or assert that an accepted step saved pre-change is still found. This is the regression that would silently cost the user ~260 re-pastes.
5. `validateNonApiAiSubmission` **rejects** a response carrying a different `HANDOFF-` code, and the message names both codes.
6. `validateNonApiAiSubmission` **accepts** a response carrying no code at all (backwards compatibility).
7. `handoffCode` is **stripped** from the value returned to callers.
8. The free-text path strips a matching `Handoff:` first line and returns the prose unchanged otherwise.
9. A wrong-batch `job-preference-evaluation` response is rejected by the v2 listing validator even when both batches have eight rows and the same preference plan. Cover foreign IDs, missing IDs, swapped IDs, duplicate IDs, and the partial-recovery path retaining root-batch IDs.
10. A v1 positional row is accepted only through the explicit accepted-durable replay alias; a fresh v2 response cannot use that path.

**Registration convention** (`scripts/test-runner.js`, `validateTestRegistry()` at 90-129): a test file must `export default [{ name, run }, ...]`, be imported at the top of `test-runner.js`, and be added as a `[filename, importedVar]` tuple to `testGroups`. Test names must be **globally unique across the whole suite** or the run fails.

---

## 7. Stop conditions / verdict rule

You are done when **all** of these hold:

1. `npm test` reports **0 failed**. Use `npm test` — **not** bare `node scripts/test-runner.js`, which fabricates ~8 failures that look stable because it skips the Electron stub (`project_test_command_electron_stub`).
2. `npm run build:compile` succeeds.
3. You have **manually verified the renderer change renders**. `npm test` and `build:compile` cannot catch a render-phase crash in `src/` — nothing in the suite ever mounts a component (`project_renderer_runtime_test_blindspot`). Use the `/run` skill or launch the app and open the handoff dock with ≥2 pending requests.
4. A wrong-batch paste is rejected with a message naming both codes, and a code-free paste is still accepted.
5. An accepted durable step created **before** your change is still found **after** it (test 4 above).

If any of 1–5 cannot be met, stop and report which one and why rather than relaxing the check.

**Completed verification:** `npm test` passed 1,128 unit tests and 392 PDF tests (1,520 passed, 0 failed). `npm run build:compile` and `npm run lint` passed. The renderer was manually checked with two pending handoffs. The 10-pending selector layout uses one 10-button desktop row and two five-button narrow-viewport rows, with no horizontal scroll. Wrong-code rejection names both codes, code-free submission remains accepted, and a pre-change durable step is still found.

---

## 8. Hand back to the user

Report, briefly:

- Batch 38/39 shared one response; exact snapshot recovery established that it belonged to batch 38, leaving batch 39 wrong. The user authorized the rerun. The completed atomic repair installed both eight-job legacy-v1 responses after validating their recovered listing slices/local indexes, all 32 preference IDs, and verbatim quotes. It created a mode-`0600` backup and left no accepted duplicate response group.
- HANDOFF paste verification and required per-listing opaque IDs now prevent the same positional-identity failure for fresh responses. The legacy positional path is limited to a uniquely selected, already accepted v1 durable response with its exact historical contract.
