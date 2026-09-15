# Résumé Achievement Mining — Final Design

Prepared: 2026-08-11
Target: job search module (`jobhub` / `jobcard` / application generation)
Audience: next Claude Code instance implementing this in the repo.
Status: **design settled, nothing built.** No code changed when this was written.
Revised: 2026-08-11, after a review pass that verified every code citation against the repo and
found five design defects (receipt matching, arithmetic edge cases, the missing `computed` field,
the cover-letter gap, and the mining race) — all folded in below.

UPDATE — this design has since been **built** (achievement ledger, model resolver, HTML generation,
receipts). The applied-jobs store described below was later retired in favor of the simpler
search → hierarchy → bundle → manual submission → delete hierarchy workflow. Two other things
below drifted from this original plan during
implementation and are corrected in place rather than left to mislead a future reader: §3.1's
Claude pin (reverted — see the note under the task table) and §5's "PDF generation goes away
entirely" (reversed — a PDF companion came back, see the note under §5.1). Everything else in
this document remains an accurate record of what was decided and why.

UPDATE (2026-09-14) — **the app has since dropped direct Gemini/Claude API access entirely.**
Every AI call, including the achievement-mining and refute tasks below, now goes through the
manual copy/paste handoff in `electron/ipc/nonApiAi.js`: the user is shown a prompt, pastes it
into their own chat app, and pastes the reply back. There is exactly one transport — no provider
setting, no model family, no Models API resolver, no prompt caching, and no cap-raise retry.
Consequently **§8 (Part F — Always-latest model selection) describes a `modelResolver.js` that
was never built and now never will be** — `providerForTask`/`modelForTask` and the whole
Claude/Gemini routing layer this section extends were removed, not upgraded. §3.1's `TASK_MODELS`
table, §10's registration checklist, §11's `modelResolver` test bullet, and §12's build-order item
0 are historical context only; a task is registered today by adding its id to the plain
`KNOWN_TASKS` set and giving it a `TASK_MAX_TOKENS` entry in `electron/ipc/llm.js` — nothing else.

---

## Executive Summary

The résumé generator restates and reframes the candidate's career data. It does not **derive
accomplishments by joining facts that sit in different places in the corpus**.

The motivating example: a CFO starts in 2019, a balance sheet in the corpus shows $4.2M debt; a
2023 balance sheet shows $1.1M. Nowhere does the career data say "cut debt 74%" — but that is the
strongest line on the résumé, and the candidate should not have to find it themselves.

Six changes, in dependency order:

0. ~~Always-latest model selection~~ — MOOT (see the 2026-09-14 UPDATE above). This item proposed
   replacing `TASK_MODELS`' literal Claude IDs with a Models-API resolver; the whole direct-API
   layer it would have resolved against was removed instead, so there is no model selection left
   to keep current.
1. **Retired: applied-jobs store** — this explicit status action was removed. The canvas-scoped
   shown-job history remains the only search deduplication mechanism.
2. **HTML-first output** — stop generating PDFs *the old way*. Ship a single-file HTML workspace the user
   opens in Chrome, edits in place, and can export to PDF via the browser. (As built, a PDF
   companion later came back as an automated, in-app render — see the note under §5.1 — but the
   HTML stays primary and editable exactly as designed here.)
3. **Broadened transcription** — so financial statements, metrics docs and performance reviews
   survive `career-file-extract` with their numbers intact. Without this the miner has nothing.
4. **Achievement Ledger** — a job-independent mining pass (+ an independent refute pass) run
   lazily on the first Generate from a hub, cached on the hub node.
5. **Receipts** — every derived figure carries a hover tooltip showing its derivation, hidden in
   print.

---

## 1. Problem statement

### The three operations

| | Operation | Example | Today |
|---|---|---|---|
| 1 | **Restate** | "Managed company finances" | yes |
| 2 | **Infer capability** | "shipped REST APIs" → comfortable with API design | yes, explicitly licensed |
| 3 | **Derive accomplishment** | debt $4.2M (2019) ⋈ debt $1.1M (2023) ⋈ CFO 2019– → "cut debt 74%" | **no** |

Operation 3 is a *join across facts in different places* + arithmetic + a credit-attribution
judgment. Nothing in the system names it, asks for it, or gives it anywhere to live.

### Why it doesn't happen today

`electron/ipc/jobApplication.js:105-150` (`generateResumeMain`) is a single Opus call that must
simultaneously read the raw multi-file corpus, select what's relevant, tailor to the JD, and emit
exact `<main class="page">` markup with specific class names. Four observations:

- The "FAIR INFERENCES" clause (`jobApplication.js:123`) is entirely about operation 2 — every
  worked example is a lateral skill inference from a single fact.
- `NEVER invent … specific metrics/numbers the data doesn't support` (`:122`) does not technically
  forbid a derived number, but it is permission by omission. A conservative model writing an
  employer-facing document defaults to figures that appear verbatim.
- Format compliance is a strong attractor. Mining is the first thing to go shallow.
- No artifact anywhere in the codebase represents "what this person accomplished." `careerData` is
  prose; `resumeProfile` (`RESUME_PARSE_SCHEMA`, `aiSchemas.js:255-268`) is a coarse skills bag used
  only for job scoring, never for the résumé.

### Design decisions taken during discussion

- **Inference is now split by evidence, not handled as one generous résumé-writing rule.**
  Capabilities directly entailed by concrete work may be stated. A close but unverified skill
  (for example Django ORM when the corpus shows substantial database-backed Django work) enters a
  candidate review queue only when it is a high-impact requirement for the target job. A more
  distant high-impact skill enters a private learning queue. Neither enters employer-facing copy
  without verification.
- **Human review is a light wording glance, not an audit.** Assume it catches only outrageous
  errors. A deep manual check "is tiring to do and invalidates the whole point of this system."
  Therefore machine-side rigor carries the weight, and receipts must cost the reader ~nothing.
- **Nothing gates.** Failed checks demote and annotate; they never block generation.
- **Attribution is best-effort reasoning**, not a conservatism ratchet.

### 2026-08-14 skill-demand extension

Every application generation now runs a separate structured skill-opportunity analysis after role
research. It emits only missing skills whose possession would materially change the outcome for
that job, split into `verify` (nearby but unverified) and `learn` (too distant to claim). The AI maps
role-title and skill-name aliases to the existing app-global taxonomy; deterministic code records
one demand occurrence per canonical skill per job card in `skill-opportunity-histogram.json`.
Regenerating the same card replaces its prior successful contribution, so only the latest résumé
generation affects the bars; a failed or stale retry leaves the last successful contribution
intact. Version 2 preserves pre-upgrade aggregate counts as an immutable baseline because the old
format had no card identity, then deterministically rebuilds the visible aggregate from that
baseline plus a latest-contribution ledger keyed by the stable job-card `nodeId`. The single-file
résumé HTML is a two-pane workspace with the
review queue, private learning queue, and a role-selectable horizontal demand histogram. Export is
gated until every `verify` item is resolved; only user-confirmed labels are inserted into the
printed résumé. `learn` items never enter the résumé. The workspace also discloses the actual
successful AI model or models used to produce the bundle, including a serving fallback and a
conditional résumé length-revision pass; failed/degraded calls and provider error details are not
embedded in `Application.html`.

---

## 2. Architecture

```
career files ──► career-file-extract (per file, broadened)
                        │
                        ▼
                   careerData  (flat text, immutable for hub's life)
                        │
                        ├──► resume-parse ──► resumeProfile  (scoring only, unchanged)
                        │
                        ▼  [lazy, on FIRST Generate from this hub]
              career-achievement-mining   (Opus, job-independent)
                        │
                        ▼
              deterministic checks (JS: arithmetic, evidence, dates)
                        │
                        ▼
              career-achievement-refute   (Sonnet, independent adversary)
                        │
                        ▼
                 data.achievements  ◄── cached on the jobhub node
                        │
   ┌────────────────────┴────────────────────┐
   ▼                                          ▼
application-resume                   application-cover-letter
(ledger + careerData + JD + research + rubric)
   │
   ▼
buildResumeDocument → single-file HTML (inlined CSS, CDN fonts, injected chrome, receipts)
```

### Why job-independent mining, triggered at generation time

Two positions were weighed. Mining *scoped to the target job* was rejected on one argument:
**JD-scoping filters before deriving, and you cannot filter for what hasn't been discovered yet.**
"Managed company finances" + a balance sheet does not read as relevant to a VP Finance posting;
"cut debt 74% over four years" does. A miner asked to judge relevance while looking at raw facts
makes that call at the moment it has the least information, and the failure is silent. What makes a
candidate stand out is also frequently the thing the JD did not ask for.

The scope concern behind JD-scoping is real but is fixed by **bounding on strength rather than
relevance** — strength is job-independent. Cap at ~30 items ranked by strength.

Cost is not the deciding axis: `careerData` is ~750–2,400 tokens for one résumé, ~4k–12k for a
five-file corpus; per-job mining would be ~$0.12/application, hub-cached mining ~$0.20 once. Both
are noise.

**Trigger on first Generate** (not at drop time): zero cost if you never apply from a hub. **Scope
job-independently**: discovery is not pre-filtered. **Cache on the hub**: amortized across every
application, and — critically — *the same number every time*. Two applications to one company must
not carry two independently-derived figures.

`careerData` is locked to a hub's first drop and hubs are never re-dropped (a new corpus means a new
hub), so the ledger can never go stale. No invalidation logic needed.

---

## 3. Part A — Achievement Ledger

### 3.1 New LLM tasks

UPDATE (2026-09-14) — as built today, registration is just adding the task id to the `KNOWN_TASKS`
set and giving it a `TASK_MAX_TOKENS` entry in `electron/ipc/llm.js`; the `TASK_MODELS` table, the
per-task Claude/Gemini/pin columns below, and `resolveTask`'s `'default'` fallback no longer exist
— every task shares the single manual-handoff transport. The paragraph and table immediately below
describe the routing table as it stood when this was written; kept for the reasoning, not as a
contract.

Register in `electron/ipc/llm.js` — **both** `TASK_MODELS` (`:45-77`) and `TASK_MAX_TOKENS`
(`:96-182`). A missing `TASK_MODELS` entry silently falls back to `'default'`
(`resolveTask`, `:184-190`) — a quality regression with no crash, so do not skip it.

| task | claude | gemini | pin | max tokens | rationale |
|---|---|---|---|---|---|
| `career-achievement-mining` | `OPUS` | `gemini-3.7-flash` | `claude` | 24576 | highest-leverage reasoning in the pipeline; runs **once per hub**, not per application |
| `career-achievement-refute` | `SONNET` | `gemini-3.5-flash` | `claude` | 8192 | a *different* model from the miner buys real independence, and is cheaper |

`OPUS` / `SONNET` are **family tokens**, not literal IDs — see §8, Model selection. Add a
doc-comment justifying the Opus row, per the convention at `llm.js:14-44`.

UPDATE — **the `pin: 'claude'` column above was REVERTED and does not reflect the shipped
behavior.** As originally designed, these tasks (and the rest of the application-generation
pipeline) ran on Claude regardless of the user's provider setting. Jack later reversed that
call: résumé/cover-letter generation now follows the same provider+model routing as every
other task (`providerForTask`, `electron/ipc/llm.js`) — a Gemini-provider user gets ledger
mining, refuting, and generation on Gemini too. Nothing in this pipeline is pinned to a
provider anymore.

The live Claude routing has since been redesigned around three Settings groups:
`Judgment` (Opus default), `Extraction` (Sonnet default), and `Light` (Haiku default);
see `TASK_GROUPS` in `llm.js` and `ai.claudeModels` in `settings.js`. Application generation
is now a Local AI handoff, so the historical `generation` and `analysis` groups described
above are no longer live routing concepts. This section's mining/refute group and ladder-step
details are retained as historical design context only, not an implementation contract.

UPDATE (2026-09-14) — those three Settings groups (`Judgment`/`Extraction`/`Light`) are themselves
gone now: `ai.claudeModels` was removed from Settings along with `ai.provider` and the API-key
fields, and `TASK_GROUPS`/`GROUP_DEFAULT_FAMILY` were deleted from `llm.js`. Every task, mining and
refute included, is a manual copy/paste handoff with no group, family, or provider distinction.

The mining cap is deliberately above the 16384 used by `career-file-extract`: a ledger of ~40
items each carrying verbatim evidence quotes is a larger output than a single file's
transcription, and a truncated ledger silently drops achievements — the same argument the
codebase already makes at `llm.js:132-138`. Caps bill on actual output, so the headroom is free.

`effectiveCap()` (`tokenBudget.js:98-122`) self-calibrates upward from observed usage, so these
seeds are floors, not tuned finals.

UPDATE (2026-09-14) — `tokenBudget.js` was deleted with the rest of the direct-API layer; there is
no cap-raise retry or self-calibration under the manual handoff. `TASK_MAX_TOKENS` in `llm.js` is
now a static, one-shot ceiling written into the copied prompt as guidance for the human's chosen
chat app — a paste that got cut off is a failure the user has to notice and re-paste, not a caught
truncation, so size these seeds generously rather than counting on upward drift.

### 3.2 Ledger schema

New in `electron/ipc/aiSchemas.js`. Nested objects inside arrays are fully supported —
`toGeminiSchema` (`gemini.js:58-78`) recurses into both `properties` and `items`. **Do not use**
`anyOf` / `oneOf` / `$ref` / `additionalProperties`; they are silently stripped (`gemini.js:53-56`).
Every field you need guaranteed must be in `required` (`aiSchemas.js:6-7`).

```
ACHIEVEMENT_LEDGER_SCHEMA
  achievements: [ {
    id            string   stable within this ledger (a1, a2, …)
    claim         string   résumé-voice prose, MUST NOT contain the derived figure
    kind          enum     delta | scale | scope | first | turnaround | efficiency
                           | recognition | breadth
    roleAnchor    string   employer / role this belongs under
    strength      integer  1-100, for ranking and the ~30 cap
    attribution   enum     sole | led | contributed | context
    confidence    enum     high | medium | low
    caveats       string   confounders; empty string when none
    derivation    string   the join, human-readable, e.g. "debt $4.2M (2019 balance
                           sheet) → $1.1M (2023 balance sheet); CFO tenure Mar 2019–present"
    metric: {
      isNumeric      boolean
      baselineValue  number   0 when !isNumeric
      baselineLabel  string   "2019 balance sheet"
      endpointValue  number   0 when !isNumeric
      endpointLabel  string   "2023 balance sheet"
      unit           string   "USD" | "%" | "ms" | "people" | ""
      direction      enum     increase | decrease | flat
    }
    evidence: [ { file string, quote string } ]   VERBATIM spans from careerData;
                           `file` MUST name one of the `===== FILE: <name> =====`
                           sections the quote came from (checked — see §3.4)
  } ]
  gaps: [ { roleAnchor string, note string } ]    non-blocking suggestions
```

**Written by code, not the model** — added to each item by the checks in §3.4, and part of the
persisted shape the résumé call consumes:

```
  computed: {
    isNumeric  boolean   false → no figure, no receipt (see §3.4)
    delta      number    endpointValue − baselineValue, signed
    pct        number|null   null when baseline is 0 or !isNumeric
    display    string    the exact string the résumé must use, e.g.
                         "74% ($4.2M → $1.1M)" or "$3.1M ($4.2M → $1.1M)"
    checks     { evidenceOk boolean, datesOk boolean }
  }
```

Field-by-field rationale:

- **`claim` excludes the figure.** The model must not author the number. Code computes it (§3.4)
  and stores `computed.display`; the résumé call receives both and weaves them. This makes an
  arithmetic slip structurally unable to reach the output.
- **`evidence` is verbatim, not paraphrase.** Enables a free JS substring check.
- **`derivation` is separate from `claim`** so it can be audited and shown as a receipt.
- **`attribution`** is the load-bearing honesty field. The dominant risk in achievement mining is
  not inventing a number, it is stealing credit — "revenue grew 40% while I was there" ≠ "I grew
  revenue 40%." Forcing a declared claim-strength is what keeps `context` items phrased as context.
- **`caveats`** surfaces confounders (a divestiture, a market tailwind) rather than burying them.
- **`gaps`** are tips only. They never gate mining or generation.

```
ACHIEVEMENT_REFUTE_SCHEMA
  verdicts: [ {
    id                    string
    verdict               enum   stands | weaken | drop
    reason                string
    suggestedAttribution  enum   sole | led | contributed | context | unchanged
    suggestedCaveat       string empty when none
  } ]
```

### 3.3 Mining prompt (shape, not final text)

Cached prefix (hub-stable): `careerData` + the mining rules. Dynamic: nothing — this call is
job-independent, so the whole prompt is effectively the prefix. Instruct it to:

- Sweep for facts that only become accomplishments **when joined**: time-series deltas across
  documents, before/after around a tenure boundary, scale implied by scope, firsts, survived
  crises, things corroborated across a brag doc and a review.
- Search generously for what counts as an accomplishment, but keep the claim and its join
  evidence-bound. Do not use achievement mining to infer unverified tool or subsystem experience;
  that now belongs to the separate skill-opportunity review flow described above.
- Rank by strength and emit at most **~40**. Weak joins are dropped at mining time. The ~30 figure
  is the *post-refute* target — mining above it leaves room for the refute pass (§3.5) to drop
  items without thinning the ledger below what a tailored résumé can draw on.
- Never author the computed figure — return raw endpoints only.
- Quote evidence verbatim.
- Declare attribution honestly; when the candidate's causal role is uncertain, use `contributed` or
  `context` and say why in `caveats` rather than dropping the item.

### 3.4 Deterministic checks (free, non-gating)

New pure module `src/utils/achievementLedger.js` (precedent: `src/utils/bundlePricing.js` and
`src/utils/jobIdentity.js` are pure `src/utils` modules imported by `electron/ipc/*`, and are
unit-tested in `scripts/test-runner.js`).

1. **Arithmetic** — compute `computed.delta`, `computed.pct` and `computed.display` from `metric`.
   The model never supplies these. Mirrors the bundle-pricing discipline
   (`bundlePricing.js:397-434`): the model returns attributable factors, **code derives every number
   and the final human-readable string**. Three cases must be handled explicitly, because each one
   otherwise reaches the PDF as a wrong number:
   - **`isNumeric: false`** — the numeric fields are 0 by schema convention, so *skip arithmetic
     entirely*. `computed.isNumeric = false`, `delta`/`pct` null, `display` empty. A non-numeric
     achievement gets no figure and no receipt; its `claim` and `derivation` stand alone. Computing
     blindly here yields `0` and `NaN`.
   - **`baselineValue === 0`** — percentage change is undefined ("grew from 0 to 40 customers").
     Set `pct: null` and express `display` as the absolute delta only.
   - **`direction` disagreeing with the sign of `delta`** — the model mislabelled the direction.
     Trust the numbers, drop `confidence` to `low`, flag it.
2. **Evidence presence** — normalize whitespace, then check each `quote` appears as a substring of
   the `===== FILE: <name> =====` section its `evidence.file` names. Falling back to a match
   anywhere in `careerData` is acceptable but records a weaker `evidenceOk`; a quote that appears
   nowhere → demote `confidence` to `low` and flag. Never delete. (Scoping to the named file is
   what makes the `file` field load-bearing rather than decorative — an item citing a real quote
   from the wrong document is a mis-derivation worth catching.)
3. **Date sanity** — where labels parse to dates, check ordering and that they fall inside the
   corpus's date span. Light and advisory; failures set `checks.datesOk` false.
4. **Attribution consistency** — `context` items are marked so the résumé prompt phrases them as
   context ("during tenure…"), never as a personal win.

Non-gating is a hard rule: nothing here blocks generation.

### 3.5 Refute pass

A second call with a *different* model, given the checked ledger and asked to **attack** each item:
is the join valid, is attribution overstated, is there a confounder that explains the delta better
than the candidate's work?

Apply verdicts: `drop` removes the item; `weaken` applies `suggestedAttribution` /
`suggestedCaveat` and demotes confidence; `stands` passes through. **Then** truncate to the top ~30
by `strength` — the cap is applied here, after refutation, not at mining time (§3.3).

This is the one failure class that neither code nor a light wording glance can catch, and at two
calls per *hub* (~$0.05 total, amortized over every application from that hub) it is the best-value
spend in the design. There is no verify/critique precedent in the codebase — this establishes it.

### 3.6 Persistence and triggering

Stored on the `jobhub` node:

```js
data.achievements = {
  version: 1,
  minedAt: <ms>,
  minedBy: { miner: '<resolved model id>', refuter: '<resolved model id>' },
  ledger: [ …checked, refuted items… ],
  stats: { mined, droppedByRefute, demotedByCheck, evidenceMisses },
}
```

Node `data` persists by default (`serializationUtils.js:314-435`); a field survives save/load as
long as it is **not** added to `JOBSEARCH_TRANSIENT_KEYS` in `persistenceTransientState.js`. Do not
add it. **No `MIGRATIONS` entry is needed** — this is purely additive and readers default when
absent (`serializationUtils.js:201-265`).

Flow:

1. `JobCardNode.generateApplication` (`src/nodes/JobCardNode.jsx:87`) already reads `careerData` off
   the origin hub. Also read `originHub.data.achievements` and pass it through.
2. `generate-application` (`electron/ipc/jobApplication.js:219-276`) mines + checks + refutes **only
   when the passed ledger is absent**, and returns it in the result.
3. The card writes it back via `updateGlobal(originHubId, { achievements })`.

**Concurrency needs a guard — don't skip it.** Two cards generating at once both see an absent
ledger, both mine, and the hub keeps whichever write lands last. Job A's résumé was then built from
a ledger the hub no longer holds, so the two applications carry independently-derived figures for
the same underlying fact. That is precisely the failure hub-caching exists to prevent (§2), so
"last write wins" is not an acceptable outcome here even though nothing crashes.

Guard with an in-flight marker on the hub (`data.achievementsMining = <ms>`): the second card sees
it, skips mining, and proceeds on `careerData` alone for that one application (§3.7's degraded
path) rather than racing. Stale markers older than a few minutes are ignored so a crashed run
can't wedge the hub permanently.

Cancellation is already handled — `handleSafe` threads an `AbortSignal` into every `callLLM*`
(`ipcUtils.js:120-154`) and nothing partial is persisted, so a cancelled mine simply re-mines next
time.

### 3.7 Failure behavior

Mining or refuting failing must **never** block generation — fall back to today's behavior
(`careerData` alone). Same graceful-degradation shape as bundle pricing, where a failed second call
leaves the arithmetic sum as the headline (`marketplace.js:1435-1440`, `SellHubNode.jsx:687-707`).

---

## 4. Part B — Résumé generation changes

All in `electron/ipc/jobApplication.js`.

### 4.1 Cached prefix additions

The prefix must stay **byte-stable across calls** or the Claude cache marker misses
(`llm.js:344-348`, `jobApplication.js:106-109`). Everything added here is hub-stable.

- **The ledger**, serialized with **deterministic key ordering**. A `JSON.stringify` over an object
  whose key order varies between calls silently destroys the cache hit. Serialize through an
  explicit field-order helper.
- **The editorial rubric**, read at runtime from `Job Application Design System/SKILL.md` and
  `Job Application Design System/readme.md` and injected **whole**. Do not parse sections by heading —
  heading text is exactly what changes when the design system is replaced. If the files are absent,
  skip the injection rather than failing generation.

That last rule is deliberately the opposite of the startup assertion in §9, and the asymmetry is
the point: the CSS files and the `<main>` sample are **structural** — without them the output is a
broken document, so their absence must fail loudly. The rubric is **enhancement** — without it the
résumé is merely less well-edited, which is not worth blocking an application over. Fail loudly on
what breaks the artifact; degrade quietly on what only improves it.

The rubric matters because it is currently lost entirely: only a regex-extracted `<main>` sample
reaches the model, so the docs' content thesis never does. Missing today are the banned-adjective
rule, the preferred/avoided verb lists, the 1.0–2.0-line bullet ceiling, the
Problem→Solution→Measurement→Trade-off four-beat, the skim-priority ordering, the ✔/✘ worked
example pairs, and the one-annotation-per-bullet cap. The ledger supplies *what* to show off; the
rubric supplies *how to phrase it*.

Prefix growth is ~8–12k tokens, billed at ~0.1× after the first call per hub.

### 4.2 Prompt amendments

- **TRUTHFULNESS block**: amend so that "never invent metrics/numbers" explicitly **excludes
  verified ledger figures**. Without this edit a conservative model ignores the ledger and the whole
  feature is wasted.
- **Inference boundary**: state only capabilities directly entailed by demonstrated work. Feed
  job-significant but unverified adjacent skills to the private review/learning workflow instead of
  employer-facing prose.
- **Ledger is a floor, not a ceiling**: the model still receives full `careerData` and is told to
  dig further for anything the JD emphasizes that the ledger missed.
- **Attribution phrasing**: `context` items must be phrased as context, never as personal wins.
- **Receipt emission**: when using a ledger figure, wrap it as
  `<strong data-achievement-id="a3">74%</strong>` — the model emits **only the ledger id**, never
  the derivation prose. See §4.3 for why.
- **Thin the class enumeration** — this is **line `:129` only**, the `.resume-header/.name/…`
  recitation. It duplicates what the extracted `<main>` sample already conveys, so it is a second
  place to update on a design-system reconnect. Lines `:127`, `:128` and `:130` are the `RULES:`
  header, the output-only-the-block rule, and pull-from-CAREER-DATA — **keep those**, along with the
  rest of the policy the sample cannot express: bullet counts, drop-unsupported-sections, variant
  selection (`data-print` / `data-mono` / `data-page`), no-icons/skill-bars/summary-paragraph.

### 4.3 Receipt integrity

The chain that makes the tooltip trustworthy:

1. Miner returns raw endpoints and the `derivation` prose; **JS computes** every figure
   (`computed.display`).
2. The résumé model emits **an id, not prose**: `<strong data-achievement-id="a3">74%</strong>`.
3. **Post-process in `resumeHtml.js` resolves each id against the ledger and writes the tooltip
   text itself**, then drops any `data-achievement-id` that doesn't resolve. The model cannot author
   its own receipts, and it cannot corrupt one either.
4. Only *derived* figures get the treatment. Numbers quoted verbatim from `careerData` stay plain —
   if everything is underlined, the underline stops meaning anything.

**Why an id rather than the verbatim derivation string.** An earlier version of this design had the
model copy `derivation` into `data-derivation` and stripped any value that didn't match a ledger
entry. That fails in the wrong direction: a paraphrase, a normalized dash, or an HTML-escaped
character makes a *correct* figure lose its receipt, silently — and under a light wording review a
missing tooltip is invisible. An id is a short exact token the model has no reason to reword, the
match is a map lookup rather than a string comparison, and the prompt gets smaller because the
derivation prose never has to survive a round trip through the model.

Both `data-achievement-id` and the injected `data-derivation` are deliberately **attributes, not
classes**: attributes need no re-wiring when the design system is replaced.

### 4.4 Cover letter

The cover letter consumes the ledger too — the architecture in §2 shows it, and it is the same
argument: "each paragraph ties SPECIFIC career-data evidence to SPECIFIC job requirements"
(`jobApplication.js:166`) is exactly what a derived accomplishment is for.

`generateCoverLetterFields` (`jobApplication.js:153-182`) gets the same three cached-prefix
additions as the résumé — ledger, rubric, amended truthfulness clause — with two differences:

- **No receipts.** The cover letter's markup is built programmatically from typed fields
  (`resumeHtml.js:112-189`), and `APPLICATION_COVER_LETTER_SCHEMA`'s `paragraphs[]` are plain
  strings with nowhere to hang an attribute. Figures used here are unadorned prose. That is
  acceptable: any figure the letter uses also appears in the résumé, where it *does* carry a
  receipt, so the number is still checkable in one place.
- **Fewer of them.** Instruct it to draw on at most two or three ledger items — a cover letter that
  recites the résumé's numbers reads as padding.

Its prefix stays byte-stable for the same reason the résumé's does (§4.1), so the ledger must be
serialized through the same deterministic helper.

---

## 5. Part C — HTML-first output

### 5.1 What retires

UPDATE — **PDF generation did NOT go away entirely, as originally planned here.** This
subsection is preserved as a record of the original plan and rationale, but the outcome
changed: `electron/ipc/resumePdf.js` (the puppeteer-core-against-system-Chrome path
described just below) was indeed deleted, and stayed deleted. But a PDF companion later came
back via a different route — `electron/ipc/resumeRender.js` — driven by
`jobApplication.js`'s render → page-count → fit loop (SKILL.md §5's "compact-density
algorithm"). It renders through Electron's OWN `webContents.printToPDF` (no puppeteer, no
extra Chromium download) against the exact same single-file HTML `resumeHtml.js` builds,
then — for the `dual-pdf` variant — still runs the bytes through `build/dual-mode-pdf.js`'s
`addOcgBackground`, exactly as described below, just loaded differently: not a CJS
`Function(...)` eval of the Node branch (confirmed broken in a packaged build — `pdf-lib`
lives in `app.asar/node_modules`, a non-ancestor of the sibling-of-asar
`Job Application Design System/` the UMD would try to `require()` from), but an in-realm eval of the
UMD's *browser* branch with our own already-imported `pdf-lib` injected as `self.PDFLib`. The
HTML remains primary and editable exactly as this section intended; the PDF is a generated
companion written next to it, not a replacement for it, and never blocks generation if
rendering fails. The rest of this section (§5.1's puppeteer/Chrome-launch description, §5.2
onward) still accurately describes the HTML document itself and is unchanged.

PDF generation was originally meant to go away entirely. `electron/ipc/resumePdf.js` used to
launch puppeteer-core against system Chrome (`:152-156`), render with `printBackground` +
`preferCSSPageSize` (`:114-130`), then post-process the PDF bytes through
`build/dual-mode-pdf.js`'s `addOcgBackground` — loaded via a hand-rolled CJS `Function(...)`
eval to dodge ESM/asar issues (`:46-61`) — to inject an OCG layer painting cream behind every
page.

**All of that exists only because one PDF had to be both the screen artifact and the print
artifact.** Once the browser tab *is* the screen view, the design system's existing
`@media print` rule (`colors_and_type.css:394-409`) already flips `--bg` to transparent on print,
for free. Retire: the puppeteer launch, Chrome-path discovery, and the CJS-eval hack.
`puppeteer-core` stays as a dependency — the scraper uses it.

(As built — see the UPDATE note under §5.1 — the OCG rewrite did NOT retire along with the
above. It came back scoped to `resumeRender.js`'s PDF-companion path, evaluating the UMD's
browser branch instead of its Node branch, rather than being deleted outright.)

The `data-print="dual-pdf"` / `ink-only` / `data-mono` / `data-page="a4"` variant system stays
exactly as the design system defines it; `extractVariantAttrs` (`resumeHtml.js:48-55`) is unchanged.

### 5.2 Document builder changes

`buildResumeDocument` / `buildCoverLetterDocument` (`electron/ipc/resumeHtml.js:72-96`, `:112-189`)
today emit `<link rel="stylesheet" href="…">` pointing at CSS files copied next to the HTML in a
temp dir. For a standalone file:

- **Inline the stylesheets** — read the CSS text at build time and emit one `<style>`. The current
  design contract preserves its Google Fonts `@import`; safe local font URLs remain supported for
  a future re-vendoring change. Read-only access to `Job Application Design System/`; nothing in that folder
  is modified.
- **Append an injected chrome block** *after* the design-system CSS, namespaced `ic-` so a wholesale
  design replacement can never collide:
  - derivation tooltip styling (faint dotted underline, hover panel)
  - edit-mode toggle (`contenteditable` on `<main>`), export button (`window.print()`)
  - a print hint bar
  - a font-load warning banner
- **Everything injected is `@media print { display: none }`.** The printed artifact must be
  byte-identical in appearance to what the design system produces today.

### 5.3 Fonts — load and verify

`colors_and_type.css` requests the seven pinned faces from Google Fonts:
Source Serif 4 400/600, Inter 400/500/600, and IBM Plex Mono 400/500. The
generated HTML therefore has no sibling asset dependency, but it does require
access to `fonts.googleapis.com` and `fonts.gstatic.com` when opened or rendered.

`document.fonts.ready` still means loading *finished*, not that each web face
succeeded. The injected script and hidden PDF renderer therefore derive the
exact faces used in document text and check each one with
`document.fonts.check()`. A CDN, content-blocker, or browser font-load failure
shows a print-hidden warning, prevents fallback PDFs from shipping, and records
missing faces for diagnosis.

If a replacement design system changes typography, update its import, font
tokens, renderer preload descriptors, and startup assertion together.

### 5.4 Print fidelity

The exported PDF is still what gets uploaded to portals, so print fidelity still matters. Chrome's
print dialog adds URL/date headers by default, which collide with the design system's own
`@page @bottom-right` page counter (`resume.css:57-94`), and its margin default overrides the
`preferCSSPageSize` behavior the headless path gets for free.

Mitigation: a print-hidden hint bar plus an Export button that calls `window.print()` —
*"uncheck Headers and footers · margins → Default."*

### 5.5 Edit mode

`contenteditable` edits vanish on reload. Autosave to `localStorage` keyed by a document id, plus a
"download edited copy" affordance. There is a mature `contenteditable` pattern in the repo already
(`src/nodes/TextNode.jsx:151`, `src/utils/nativeTextUndo.js:28`) to model on.

Note `Job Application Design System/readme.md:15-19` documents the opposite intent — *"No human interactive
surface. No editor."* That doc is design-owned and must not be edited; record the deliberate
divergence here instead, so a future instance does not "fix" the editor away.

### 5.6 Output files

`save-application` (`jobApplication.js:282-314`) copies `.html` instead of `.pdf`. Folder gains
location (§6.3) — note the handler receives `company` / `jobTitle` / `candidateName` but **not**
`location` today. No backend threading is needed: `data.location` is already on `JobCardNode` (it
goes into the `job` object passed to `generateApplication`), so this is one added field on the
`saveApplication` call at `JobCardNode.jsx:120-143`.

```
<canvas dir>/Applied Jobs/<company>/<location>/<role>/
    <candidate> - Resume.html
    <candidate> - Cover Letter.html
```

UPDATE — as built, `save-application` copies a THIRD file when the render → fit loop (§5.1's
UPDATE note) succeeded: `<candidate> - Resume.pdf`, the rendered PDF companion
(`resumePdfPath` on the `generate-application` result). Rendering failure degrades to
HTML-only rather than blocking the save. The cover letter has no PDF companion — only the
résumé goes through the fit loop.

`copyUnique` collision handling (`:189-201`) is unchanged.

---

## 6. Part D — Search history and disposable application hierarchies

The proposed applied-jobs store was retired. Infinite Canvas deliberately does not infer or retain
an application-submission status: generating a bundle is not applying, and submission happens
manually on the employer site. Once it is no longer useful, the displayed job hierarchy can simply
be deleted.

### 6.1 Current search deduplication

`electron/ipc/jobsHistory.js` maintains a canvas-scoped `<canvas>.jobs-history.csv` sidecar for
listings already shown in a job-board flow. It is a bounded, 60-day discovery-history record—not an
application record—and it exists solely to avoid immediately resurfacing the same listing. The file
stores the minimum identifying fields (`seen_date`, source, company, title, location, URL); old rows
are pruned so genuine reposts can return.

Identity is intentionally conservative:

- A stable listing URL is the primary key, including source-specific URL parameters when the path is
  shared by many listings.
- Without a usable URL, title + company + location is the fallback. Location-less records only
  match other location-less records.
- A conflicting visible listing never becomes hidden merely because a coarse URL or tuple collides;
  history deduplication fails open and preserves it for the user.

The deterministic history tests cover URL identity, location-distinct requisitions, malformed CSV
recovery, concurrent writes, resumed-run behavior, and collision diagnostics. Keep this mechanism
separate from cross-source job-card merging: its safety rule is to over-show a questionable listing,
never to make a real opportunity disappear.

### 6.2 Application lifecycle

Application artifacts are saved below the selected canvas-relative output root. They are useful
working files, not a CRM record or a permanent declaration that a submission occurred. The workflow
is therefore: search → score → hierarchy → bundle → manual submission → delete the hierarchy when
finished. A later search is governed only by the bounded shown-history described above.

---

## 7. Part E — Broadened transcription

`electron/ipc/jobs.js:1065` (`career-file-extract`, `task:` on `:1066`) currently enumerates *"roles, employers, dates,
bullet points, projects, skills, education, certifications, contact info."* A balance sheet's line
items are not on that list, so a faithful transcriber may drop the exact numbers the miner needs.

Broaden it to explicitly cover financial statements, metrics/dashboard exports, performance reviews
and project retrospectives, and to preserve **all figures, dates, units and table structure** even
when the content is not obviously "résumé material." Keep the existing "do not summarize away detail
and do not invent anything" constraint — this pass stays pure transcription.

Without this change the ledger has nothing to join, and the whole feature underperforms silently.

---

## 8. Part F — Always-latest model selection

UPDATE (2026-09-14) — **superseded, not built.** This whole section proposes a
`electron/ipc/modelResolver.js` that resolves Claude family tokens against the Models API. The app
instead removed direct Claude/Gemini API access entirely — `claude.js`, `gemini.js`,
`modelResolver.js`, `claudeModels.js`, `tokenWindow.js`, and `tokenBudget.js` are gone, and every
task routes through the manual copy/paste handoff (`electron/ipc/nonApiAi.js`) with no model
selection of any kind. Kept below as historical record of a rejected direction, not a design to
implement.

Not specific to achievement mining, but the new tasks in §3.1 would otherwise add two more literal
model IDs to a table that already goes stale on its own.

### 8.1 The problem

`TASK_MODELS` (`llm.js:45-77`) pins literal IDs. The current pins are `claude-opus-4-8` and
`claude-sonnet-4-6`; the current models are **`claude-opus-5`** and **`claude-sonnet-5`**. Both
upgrades are free or better on price:

| pinned | $/M in | $/M out | current | $/M in | $/M out |
|---|---|---|---|---|---|
| `claude-opus-4-8` | $5 | $25 | `claude-opus-5` | $5 | $25 |
| `claude-sonnet-4-6` | $3 | $15 | `claude-sonnet-5` | $3 ($2 introductory through 2026-08-31) | $15 ($10 intro) |

So the pins cost quality for nothing. And a literal table means every model generation is a manual
sweep that nobody remembers to do — which is how it got two generations behind.

### 8.2 Design

Replace the literal Claude IDs in `TASK_MODELS` with **family tokens** — `OPUS`, `SONNET`,
`HAIKU` — resolved at call time by a new `electron/ipc/modelResolver.js`.

Resolution uses the **Models API** (`client.models.list()`, `GET /v1/models`), which returns per
model: `id`, `display_name`, `created_at`, `max_input_tokens`, `max_tokens`, and a `capabilities`
tree with `supported` booleans at each leaf. Family match on the id (`-opus-`, `-sonnet-`,
`-haiku-`), newest by `created_at` wins. The endpoint is free, and the result is cached in a
`lazyStore('model-resolution')` with a ~24h TTL — one call a day, not one per LLM call. (This is
exactly the "learned telemetry" case `lazyStore` is documented as right for: fail-soft is correct
because §8.3 supplies a floor.)

The Gemini column stays pinned. Only the Claude side gets a resolver.

### 8.3 Three guards, all load-bearing

**1. Pinned floor.** If the Models API is unreachable, fall back to
`MODEL_FLOOR = { OPUS: 'claude-opus-5', SONNET: 'claude-sonnet-5', HAIKU: 'claude-haiku-4-5' }`.
A résumé must never fail to generate because model discovery failed. Bump the floor opportunistically
— it is a safety net, not the source of truth.

**2. Resolve once per run, not per call.** Prompt caches are **model-scoped**. A resolver that flips
between two calls in the same run silently invalidates every cached prefix and re-bills it at full
rate. Resolve at the start of a hub run (and at the start of a `generate-application` invocation)
and thread the resolved id through, the same way `careerData` is threaded. This is load-bearing for
the ledger: its entire cost argument rests on the cached prefix surviving across applications.

**3. Capability gate — a new generation is not automatically a drop-in.** Recent history:
Opus 4.7 removed `budget_tokens` and the sampling parameters outright (both now 400); Opus 5 turned
thinking on by default and made `thinking: {disabled}` a 400 above `high` effort. Auto-adopting a
future model blind could 400 the whole pipeline on the day it ships.

Gate on the `capabilities` tree the Models API already returns, requiring what this app actually
uses — **`structured_outputs.supported` above all**, since every schema-forced task in
`aiSchemas.js` depends on it, plus adaptive thinking and effort if a task requests them. A model
failing the gate is skipped and the resolver falls to the next-newest. Log the skip; a silently
skipped generation looks identical to no new generation.

Excluded from auto-tracking entirely: **Fable and Mythos**. They are a higher price tier
($10/$50 vs Opus's $5/$25) with a different API contract — thinking is always on, an explicit
`thinking: {disabled}` returns 400, and the org must be on 30-day data retention or *every* request
400s. Auto-adopting them would be an unrequested cost and compatibility change. Match on the exact
family tokens rather than "newest Claude model".

### 8.4 Two adjacent things this fixes

- **`claudeModels.js:29-49`** hardcodes context window and max-output per model. Drive both from
  `max_input_tokens` / `max_tokens` on the same cached Models API response. The token-window
  preflight (`assertPromptFits`) reads them, so a model the registry has never seen currently gets
  mis-sized — which is a fail-loud throw on a prompt that would actually have fit.
- **`CLAUDE_MODELS_IN_USE`** (the per-model availability probe) becomes the resolved set rather than
  a literal list, so the probe follows the resolver automatically.

---

## 9. Design-system boundary

`Job Application Design System/` is **owned by Claude design, read-only from this repo's side, and may be
replaced wholesale**. Reconnection after a replacement is done manually and deliberately — the goal
is *not* self-healing code, it is a small, enumerated, loud-failing coupling surface.

Rules:

- Never write into `Job Application Design System/`. All new CSS, markup and script go into
  `electron/ipc/resumeHtml.js`.
- Namespace everything injected (`ic-`) so a replacement cannot collide.
- Prefer **attributes over classes** for hooks — `data-derivation` needs no re-wiring on a swap.
- Prefer **runtime reads over copies** — the rubric is read from the docs rather than transcribed
  into a prompt string, so there is no duplicate to drift.
- Add a startup assertion that the expected CSS files exist and the `<main>` extraction succeeded.
  Its job is not to heal anything; it is to say *a reconnect is needed* instead of silently
  generating against a stale contract.

### Reconnect checklist

| # | Location | Coupling |
|---|---|---|
| 1 | `resumeHtml.js` (`CSS_FILES` const) | `CSS_FILES` filename list — migrated here from the now-deleted `resumePdf.js:70`, per plan |
| 2 | `resumeHtml.js` (`getDesignSystemDir()`) | folder resolution — migrated here from the now-deleted `resumePdf.js:78-93`, per plan. `resumeRender.js`'s `getDualModePdf()` (the PDF-companion loader — see §5.1's UPDATE note) reuses this same resolved dir, so it's a coupling point for that path too now |
| 3 | `jobApplication.js:36-44` | `getResumeSampleMain()` — regex-extracts `<main class="page">` from `resume.html`; depends on that filename and wrapper |
| 4 | `jobApplication.js:127-134` | prompt's class enumeration + policy rules |
| 5 | `resumeHtml.js:112-189` | **cover-letter markup — the largest surface** |
| 6 | `resumeHtml.js:48-55` | `extractVariantAttrs` — `data-print` / `data-mono` / `data-page` semantics |
| 7 | new | rubric doc filenames (`SKILL.md`, `readme.md`) |

Row 5 deserves attention: unlike the résumé, the cover letter's markup is **not** LLM-authored —
`buildCoverLetterDocument` constructs it programmatically and hardcodes **19**
design-system class names (`.letter-letterhead`, `.letterhead-rule`, `.letter-meta`,
`.recipient-name`, `.valediction`, `.signature-title`, …). On a swap that function is a hand
rewrite, and it fails **quietly** — the page still renders, just unstyled. This is the strongest
argument for the startup assertion covering both documents.

The HTML pivot was expected to *remove* one reconnect point: the OCG post-process and its
`CREAM` constant. UPDATE — that did not happen; see §5.1's UPDATE note. The OCG post-process
(`build/dual-mode-pdf.js`'s `addOcgBackground`, and `DEFAULT_CREAM_RGB` in it — the design
system's own module, not a constant this repo owns) came back as part of `resumeRender.js`'s
PDF-companion path and remains a live reconnect point: `DEFAULT_CREAM_RGB` must still track
`--bg` in `colors_and_type.css` on any design-system swap.

---

## 10. Registration checklist

UPDATE (2026-09-14) — the four bullets below describe registering against the removed direct-API
layer. As built today: add both task ids to the `KNOWN_TASKS` set and give each a `TASK_MAX_TOKENS`
entry in `llm.js`. That's the entire registration surface — no resolver, floor, capability gate, or
`claudeModels.js` to touch.

- [ ] ~~`TASK_MODELS` + `TASK_MAX_TOKENS` entries for both new tasks (`llm.js`)~~ — now just
      `KNOWN_TASKS` + `TASK_MAX_TOKENS`
- [ ] ~~`electron/ipc/modelResolver.js` + family tokens replacing literal Claude IDs in
      `TASK_MODELS`~~ — file deleted, not built
- [ ] ~~`MODEL_FLOOR` pinned constants; capability gate; Fable/Mythos exclusion~~ — moot, no model
      selection exists
- [ ] ~~`claudeModels.js` context/max-output driven from the Models API; `CLAUDE_MODELS_IN_USE`
      derived from the resolver~~ — `claudeModels.js` deleted
- [ ] `ACHIEVEMENT_LEDGER_SCHEMA`, `ACHIEVEMENT_REFUTE_SCHEMA` (`aiSchemas.js`)
- [ ] `src/utils/achievementLedger.js` (pure, unit-tested)
- [ ] `data.achievements` **not** added to `JOBSEARCH_TRANSIENT_KEYS`; **no** `MIGRATIONS` entry
- [ ] `data.achievementsMining` (the in-flight marker, §3.6) **is** added to
      `JOBSEARCH_TRANSIENT_KEYS` — it is run state, and persisting it across a crash would wedge
      the hub into permanently skipping its own mine
- [ ] `recordApplicationTelemetry` (`jobApplication.js:203-214`) extended with ledger stats; rendered
      in `electron/ipc/bugReport/jobsSnapshot.js:1020-1046` under "Application Generation (last)"
- [ ] startup assertion for design-system files + `<main>` extraction

Note the generic per-task token/truncation bug-report surface (`bugReport.js:1318-1350`) needs no
wiring — it works off the `task` string automatically.

---

## 11. Test plan

`scripts/test-runner.js` (single inlined suite; no `*.test.js` files exist).

- **Shown-history matching** — stable URL identity (including Indeed `jk` and Google `htidocid`),
  title/company/location fallback, URL collisions that fail open for visibly different listings,
  malformed CSV recovery, and resumed-run filtering. A questionable match must re-show a listing,
  never silently hide an opportunity.
- **`achievementLedger`** — arithmetic including all three edge cases from §3.4 (`isNumeric: false`
  produces no figure rather than `0`/`NaN`; `baselineValue: 0` produces an absolute delta and
  `pct: null`; a direction/sign disagreement demotes rather than propagates), evidence substring
  check scoped to the named file and with whitespace normalization, refute-verdict application, and
  the ~30 cap applied *after* refutation.
- **Ledger serialization** — byte-stable across repeated serialization of the same ledger (cache
  correctness).
- ~~**`modelResolver`**~~ — UPDATE (2026-09-14): not built, the module was deleted along with the
  rest of the direct-API layer; nothing to test here. Was: family match excludes Fable/Mythos;
  newest-by-`created_at` wins; a model
  failing the capability gate is skipped in favour of the next-newest; an unreachable Models API
  returns `MODEL_FLOOR` rather than throwing; a resolution is stable across repeated calls within
  one run (cache correctness — a flip mid-run re-bills every cached prefix).
- **HTML self-containment** — generated document has no external references except the design
  system's own font `@import`; injected chrome is print-hidden; a `data-achievement-id` that
  resolves gets its tooltip text injected from the ledger, and one that doesn't resolve is stripped
  along with the figure's underline.

---

## 12. Build order

Each phase ships something usable on its own.

0. ~~**Model resolver**~~ (§8) — DROPPED (2026-09-14), see the UPDATE note under §8. Was: smallest
   change, immediate payoff, and it lands before the new tasks add two more literal IDs to the
   table. Independent of everything below.
1. **HTML-first output** — inlined CSS, injected chrome, font detection, print hint, edit mode;
   retire the puppeteer/OCG path. Independent of the ledger.
2. **Broadened transcription prompt.** One prompt edit, large leverage, must precede the ledger.
3. **Ledger** — schemas, tasks, mining, deterministic checks, refute, persistence, telemetry.
4. **Résumé prompt** — rubric injection, ledger consumption, TRUTHFULNESS amendment, receipt
   emission, thinned class enumeration.
5. **Receipt tooltips** — depends on 1 and 4.
6. **Startup assertion** + reconnect-checklist documentation.

---

## 13. Explicitly rejected

- **Mining at hub-parse time** (before any job is chosen) — pays for corpora that are never used.
- **JD-scoped mining** — filters before deriving; structurally blind to the surprise case, which is
  the entire point of the feature.
- **Gating on verification** — nothing blocks generation. Checks demote and annotate.
- **A `derivations.md` sidecar** — a receipt nobody reads is a filing cabinet. Inline hover
  tooltips instead.
- **Model-copied `data-derivation` receipts** — matching the model's echoed prose against the
  ledger loses the receipt on *correct* figures whenever the model rewords by a character. The
  model emits an id; code injects the text (§4.3).
- **Literal model IDs in `TASK_MODELS`** — they go stale silently and cost quality for nothing
  (§8). Family tokens + a pinned floor instead. Fable/Mythos stay excluded from auto-tracking.
  UPDATE (2026-09-14): moot — `TASK_MODELS` and the whole model-selection layer it named were
  deleted, not fixed.
- **Additive career-data drops / hub unlock** — a new corpus means a new hub. Old hubs stay on the
  canvas as previous runs.
- **Vendoring fonts** — see §5.3.
- **A per-item review/approval UI for ledger entries** — human review is a light glance by design; a
  checklist of 30 derived claims contradicts that.
- **Any status/notes/monitoring on job cards** — cards stay disposable. The bounded shown-history
  sidecar prevents immediate rediscovery without turning the canvas into a submission pipeline.
- **Editing `Job Application Design System/`** — read-only, replaceable, manually reconnected.
