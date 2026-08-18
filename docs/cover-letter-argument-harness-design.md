# Cover-letter argument harness — design + implementation handoff

**Status:** design approved, not implemented. This document is the specification.
**Audience:** the implementing agent (Codex). Read §0 first.
**Written against:** the working tree on `main` as of 2026-08-14. `electron/ipc/jobApplication.js`
and several sibling files have uncommitted changes in flight — re-read the actual source before
editing; line numbers cited here are orientation, not contracts.

---

## 0. How to use this document

§1–§3 are the argument: why the current cover letter is mediocre and what replaces it. Read them,
because several instructions later look arbitrary until you know the reasoning, and a "sensible"
deviation will usually break the thing the design exists to protect.

§4–§11 are the build. §12 lists invariants that must not regress. §13 is the acceptance checklist.

Two house rules that govern everything here:

- **Fail loud on what breaks the artifact, degrade quietly on what only improves it.** A missing
  cover letter breaks the application bundle. A mediocre cover letter does not. Nothing in this
  design may ever prevent a letter from shipping.
- **Never fabricate.** No mock data, no placeholder fallbacks, no synthesized "example" evidence.
  When a source is missing, say so in the prompt and shrink the output.

Run tests with `npm test`. Do **not** run `node scripts/test-runner.js` directly — without the
Electron stub it fakes ~8 `getPath`/`decryptString` failures that look like a stable baseline.

---

## 1. The problem

`generateCoverLetterFields` (`electron/ipc/jobApplication.js`, ~line 861) is one LLM call whose
cached prefix is the candidate's raw career data plus a block of writing rules, and whose tail is the
job listing, the research, and letterhead field instructions. Output schema:
`APPLICATION_COVER_LETTER_SCHEMA` (`electron/ipc/aiSchemas.js`, ~line 358).

Nearly all of that prompt's mass is **negative constraint**: don't invent employers or numbers, don't
inflate scope, don't imply you're local, don't resolve a posting's example industries into a claim,
don't name excluded skills. That work is good and it is why the letters are *safe*.

There is exactly one positive instruction about what the letter should *be*:

> 3-4 body paragraphs. Each ties SPECIFIC career-data evidence to SPECIFIC job requirements, and
> references a genuine detail from the research.

One sentence, unstructured, unverified — with everything downstream of it being a formatting field.
The model is heavily fenced on truth and completely unfenced on argument, so it falls back to the
training-data mode for "cover letter," which is a polite restatement of the résumé. That is the
defect being fixed.

Five structural causes:

1. **No reader model.** The prompt never establishes that the recruiter is holding the résumé.
   Absent that, "cover letter" resolves to "self-contained introduction," which by definition
   restates the résumé.
2. **The letter cannot see the résumé.** The résumé is generated first, then the letter is generated
   from *the same* career data, *the same* ledger, *the same* job, under the same "lead with what's
   most relevant" pressure. Two calls optimizing the same objective over the same inputs converge.
   "Don't recite the résumé's numbers" is structurally unenforceable when the model has never seen it.
3. **No requirement model.** Nothing extracts and ranks what the job is actually hiring for, so the
   model back-fills an argument instead of choosing one.
4. **The schema spends its structure on the envelope.** Constrained decoding is the cheapest harness
   available and it currently buys `salutation` and `closing` — strings the prompt already dictates
   verbatim — while the load-bearing content is one free-text array.
5. **Zero post-generation validation.** The résumé gets render → page-count → compact → one revision
   → ship. The letter gets nothing, despite being rendered through the same `renderPdf` that returns
   `pageCount` (`electron/ipc/resumeRender.js:228`) and despite `Job Application Design System/STYLE.md` §11.4
   making one page a hard content rule. A two-page letter ships silently today.

---

## 2. The principle

> **The résumé is the letter's only source of evidence. The letter's job is to interpret evidence
> the reader is already holding.**

This is not only deduplication. A claim in the letter that is not on the résumé is an assertion the
reader cannot check, which *adds* interpretive work rather than removing it — the opposite of what a
cover letter is for. Making the résumé the evidence base turns "don't repeat the résumé" from an
aspiration into a property code can verify.

### 2.1 Trust the résumé — the one distinction

The letter is written **assuming the résumé is true**. It does not re-verify, re-derive, or hedge it.
Two different things are bundled in today's guards and only one of them goes:

- **Provenance guards die.** "Never invent employers, titles, dates, degrees, metrics," the entire
  verify-against-career-data apparatus, the ledger's `derivation` and `caveats` prose. All of it
  exists because the source was a raw sprawling corpus. Once the letter's evidence must near-quote a
  document that already survived those checks, re-running them is duplicated work that also invites
  the letter to second-guess the résumé — worse than useless. **Delete.**
- **The letter's own inferential step keeps a boundary.** "Coordinated with emergency personnel" →
  "served as the municipal point of contact" is not a claim about whether the résumé is true; it is
  the letter transforming a true line into a stronger one. That transformation is the letter's *core
  operation* — its whole job is "X demonstrates Y" — and inference and inflation are the same move,
  differing only in whether the conclusion is entailed. Remove all scope discipline and the one thing
  the letter is for becomes unbounded. **Keep, as a single rule.**

The truthfulness section therefore collapses from five negative rules to one axiom plus one boundary:

> The résumé is true. Do not re-derive, re-verify, or hedge it. You may not claim more than it says —
> you may explain what it means.

### 2.2 Three guards survive because they were never about the résumé

Carry these forward, effectively verbatim, from the current prompt:

- **Target-side scope.** The posting's "clients in a range of industries such as Financial
  Institutions" rule — do not resolve a posting's examples into a definite claim about *this* role.
  This guards a separate untrusted input, the job listing.
- **Geography / availability.** Governs the narrow career-data carve-out (§4.4), not the résumé.
- **Excluded skills.** Governs `skillInsights`; see §4.5 for its new dual role.

### 2.3 The ledger's role collapses

The letter no longer authors figures — it quotes figures the résumé already printed with a receipt.
So it does not need `claim`, `derivation`, `caveats`, `metric`, or `evidence`: the résumé already
survived all of them.

It needs exactly one thing. For each `data-achievement-id` appearing in the final résumé markup, the
`attribution` word for that ledger item, so a `context` item does not get re-subjected into a personal
win. That is an id→word map, not a serialized ledger.

**Consequence:** `serializeLedgerForPrompt` drops out of the cover-letter path entirely. Keep it for
the résumé path, untouched.

---

## 3. Architecture

Current per-application call sequence (unchanged parts in grey):

```
0. career-achievement-mining (+refute)   — per hub, cached on the jobhub node
1. company-research                      — grounded
2. application-skill-opportunity
3. application-resume
4. résumé render → page-count → fit loop (compact, then one revision)
--- new work starts here ---
5. application-letter-needs   JD + research                → ranked requirements
6. application-letter-plan    résumé + needs + context     → thesis, mappings, hook
   ├── deterministic plan gate → ONE retry on failure
7. application-cover-letter   plan only                    → paragraphs
   ├── deterministic prose checks
8. application-letter-revise  paragraphs + violations      → paragraphs   (conditional)
9. code assembles the letter object → buildCoverLetterDocument → renderPdf
   └── page-count backstop
```

Net +2 LLM calls in the happy path, +2 more in the worst case (plan retry, prose revision).
Cost is an accepted trade; quality is the objective here.

### 3.1 Why the needs call is separate

This is the least obvious call and the one most likely to be "simplified" away. Do not merge it into
the plan call.

Today's single call reads the posting *while already knowing what the candidate has*, so it silently
ranks requirements by which ones are easy to answer. That bias is invisible in the output and is a
large part of why generated letters read as evasive: they argue the requirements the candidate happens
to match rather than the ones that decide the hire. Splitting the read from the match is the only way
to make the bias *detectable* — once needs are ranked with no candidate in scope, "the top-ranked need
never appears in the final plan" becomes a recorded fact instead of a silent omission.

### 3.2 Why plan and prose are separate

Different optimization targets (selection and inference vs. voice), and — the real reason — a
**code gate can sit between them**. A degenerate plan gets caught and retried cheaply, before any
prose exists. Revising finished prose is the weaker intervention: by then the argument is baked in and
the model polishes rather than rethinks.

The prose call does **not** receive the résumé. It cannot recite what it cannot see; the plan already
carries the quotes it needs.

The real risk of the split is prose that reads like a filled-in form. Mitigate at the instruction
level (§6.3) and catch it with the genericness check.

---

## 4. Part A — the résumé as evidence base

### 4.1 New: résumé evidence extractor

Add to `electron/ipc/jobApplication.js`, next to the existing `summarizeResumeMarkup` (~line 623) and
the `ROLE_META_ROW` / `ROLE_LOCATION` / `ROLE_DATES` constants (~line 637). Follow that regex idiom —
the main process parses this markup with regexes, not a DOM parser, and this code must keep working
in the packaged app.

```js
export function extractResumeEvidence(mainHtml) → {
  identity: { name, tagline, contact: [string] },
  roles: [{
    title, company, dates, location, summary,
    bullets: [{ text, achievementIds: [string] }],
  }],
  skills: [{ group, items: [string] }],
  education: [string],
  achievementIds: [string],   // union across all bullets
  bulletTexts: [string],      // flat, whitespace-normalized — the overlap-check corpus
}
```

- Text values are HTML-unescaped and whitespace-collapsed. Annotation spans (`.tradeoff`, `.scope`,
  `.annotation-label`) are **kept** as part of the bullet text — they carry the trade-off reasoning a
  letter most wants to interpret.
- `achievementIds` come from `<strong data-achievement-id="…">` inside each bullet.
- Pair it with `renderResumeEvidenceForPrompt(evidence) → string`: deterministic plain text, no HTML,
  no class names. This is what goes in the prompt.

**Trap — read this.** The extractor runs on the **model's `<main>` markup** (`fitResult.mainHtml`),
never on a *built* document. The inlined design-system CSS in a built document carries several
`<main data-print=…>` examples inside comments; scanning a built document for the first `<main>` hits
a decoy. That exact mistake previously made Sync apply the wrong print variant to every application.
If you ever need to extract from a built document, strip comments first — but for this feature, take
the raw markup and don't go near built output.

The extractor is now a hard dependency of the letter, so it gets its own tests against real
design-system markup, not just against model output (§10).

### 4.2 Ordering: the letter moves after the fit loop

Today the letter is generated at ~line 1240 and the fit loop runs at ~line 1257. **Reverse this.** The
compact pass and the one-shot length revision rewrite and cut content; a letter reasoning about a
bullet the fit loop deleted is worse than one that never saw it.

The dependency is on the **final markup**, not on a successful render. A `pdfBytes: null` render
failure must not block the letter — take `fitResult.mainHtml` and proceed.

### 4.3 Letterhead identity comes from the résumé

`name`, `tagline`, and `contact` are currently re-derived from career data by the letter call, so the
two documents in a "matched pair" (`Job Application Design System/STYLE.md` §11) can silently disagree. Lift
them from `evidence.identity` instead.

`candidateLocationFromContact` (~line 927) then feeds the location-review flag from the same string the
résumé shows, which is the intended behavior.

### 4.4 Career data: narrow, structural carve-out

A résumé structurally cannot carry: stated motivation, availability, geography / relocation intent,
work authorization. The current prompt reasons about several of these explicitly.

Career data is still passed to the **plan call only**, under a distinctly labeled block whose stated
admissible use is *logistics and stated motivation only — never evidence, never accomplishments,
never capabilities*.

Make that structural rather than trusting the label: the plan schema has a separate `logistics` field
which is the **only** place a career-data-sourced fact may appear. `mappings[].evidence` is checked
against résumé text (§7.1), so career data physically cannot enter the argument.

Do not let it supply motivation content beyond what is explicitly written there. "Why this company"
grounded in research plus the trajectory visible on the résumé is honest; motivation synthesized from
a corpus is where letters start sounding fake.

### 4.5 `skillInsights` becomes a targeting signal, not only a mute list

Today it is only an exclusion list. But a ranked list of what the candidate is missing for this job is
a map of the recruiter's likely objections.

The exclusion rule stays exactly as-is — **the letter never names or implies an excluded skill.** What
is added is the positive use: pass the same list to the plan call labeled as *where the candidate is
weakest on paper*, with the instruction to compensate by leading with the strongest genuinely
demonstrated adjacent capability. Turning a negative filter into a priority signal costs nothing.

### 4.6 Scoring reasoning as a hypothesis

`data.reasoning` on the job card (see `src/nodes/JobCardNode.jsx:41`) is 2-4 sentences of "why this
candidate fits this job, citing concrete signals from both sides" — a pre-paid first draft of the
letter's thesis — and it is not in the `generateApplication` IPC payload (~line 293).

Add `reasoning` and `matchScore` to that payload and pass them to the **plan call only**, labeled as a
*hypothesis to test against the résumé, not as truth*: it was written by a batch scorer over a snippet
and may be wrong. The plan may adopt, refine, or discard it.

This is an additive IPC-payload change; no node schema migration is required.

---

## 5. Part B — the calls

Register each new task in **three places** in `electron/ipc/llm.js`:

1. the Gemini model map (~line 78) — `gemini-3.7-flash`, matching the application family;
2. `TASK_GROUPS` (~line 161);
3. the max-token cap map (~line 308).

Then add them to the `taskRoutes` telemetry array in `generateApplication`
(`electron/ipc/jobApplication.js`, ~line 1106).

| task | group | cap | notes |
|---|---|---|---|
| `application-letter-needs` | `{ group: 'generation', step: 1 }` | 2048 | feeds generation, isn't the artifact — same precedent as `company-research` |
| `application-letter-plan` | `{ group: 'generation' }` | 3072 | where quality lives; full tier |
| `application-cover-letter` | *(unchanged)* | 3072 | **reuse the existing task id for the prose call** |
| `application-letter-revise` | `{ group: 'generation' }` | 3072 | conditional |

Reusing `application-cover-letter` for prose is deliberate: `scripts/tests/ai-models.js` asserts its
routing (~lines 543, 577, 663) and Settings surfaces it. Renaming it buys nothing and breaks things.

**Cached-prefix discipline.** Every prefix must be byte-stable across applications in a session or the
cache never hits. Static rules, the editorial rubric, and the contrastive examples go in
`cachedPrefix`; anything per-job (résumé, JD, research, needs, plan) goes in the tail. Career data
leaves the letter's cached prefix entirely — accept the loss; the rubric is the large stable block and
still caches.

### 5.1 Call 1 — `application-letter-needs`

**Inputs:** job listing (via `jobBlock`), research text. **The candidate is not in scope — do not
include résumé, career data, ledger, or scoring reasoning in this prompt.** That exclusion is the
entire point of the call.

**Schema** — new `LETTER_NEEDS_SCHEMA` in `electron/ipc/aiSchemas.js`:

```
{ needs: [ {                       // 3–6, ranked, most decisive first
    need,          // one clause: what the employer needs someone to be able to do
    quote,         // VERBATIM span from the posting or research supporting it
    source,        // 'posting' | 'research'
    decisiveness,  // 1-100: how much failing this disqualifies a candidate
    kind,          // 'capability' | 'domain' | 'scale' | 'logistics' | 'credential' | 'disposition'
  } ] }
```

Rank by **what decides the hire**, not by what is listed first or repeated most. Requirements the
posting treats as table stakes rank below the ones that distinguish candidates.

When research is unavailable, `source` may only be `'posting'`. When the posting is empty and research
is unavailable, return an empty array — do not invent requirements.

`quote` must be verbatim so §7.2 can verify it.

### 5.2 Call 2 — `application-letter-plan`

**Inputs:** `renderResumeEvidenceForPrompt(evidence)`, the ranked needs, research, the id→attribution
map (§2.3), `skillInsights` (both roles, §4.5), scoring reasoning as hypothesis (§4.6), career data
under the logistics-only label (§4.4).

**Schema** — new `LETTER_PLAN_SCHEMA`:

```
{
  roleThesis,          // ONE sentence: the claim this letter argues. Not "I am excited to apply."
  mappings: [ {        // 1–2
    needIndex,         // index into the needs array
    need,              // restated in one clause
    evidence,          // near-quote of specific résumé text
    evidenceRole,      // which role block it comes from
    achievementIds: [],// ledger ids if the evidence carries a receipt figure
    resumeStatus,      // 'stated' | 'implied' | 'absent' — does the résumé already say this?
    inference,         // THE "SO WHAT". Must name the MECHANISM, not assert portability.
  } ],
  companyHook: { detail, source, whyItMattersToCandidate },   // empty when research unavailable
  logistics,           // ONLY place career-data-sourced facts may appear. Empty when not applicable.
  droppedNeeds: [ { needIndex, reason } ],   // needs deliberately not argued, and why
}
```

Field notes that are load-bearing:

- **`resumeStatus`** is the anti-redundancy lever. Forcing the model to declare "the résumé already
  states this" makes the letter's remaining job explicit: supply the interpretation, not the fact.
- **`inference` must name the mechanism.** "Dispatch triage is the same constraint as on-call
  escalation — ranking incomplete reports under time pressure with no ability to pause intake" is an
  argument. "My dispatch experience translates well to on-call" is a claim the reader must take on
  faith, which is the failure we started from. This matters most for career changers, which is where a
  letter is worth the most and where today's one-sentence instruction helps least.
- **`droppedNeeds`** is what makes §3.1's bias visible. If the top-ranked need is dropped, that is now
  a recorded fact with a stated reason.

### 5.3 Call 3 — `application-cover-letter` (prose)

**Input: the plan, plus company/title for voice. Nothing else.** No résumé, no career data, no ledger.

**Schema** — replace `APPLICATION_COVER_LETTER_SCHEMA` with:

```
{ paragraphs: [string] }
```

Everything else is code-authored (§6.1).

### 5.4 Call 4 — `application-letter-revise` (conditional)

Fires only on a §7 check failure. Input: the paragraphs, the plan, and the **specific violations**
("paragraph 2 shares a 14-word verbatim run with a résumé bullet"; "no company-specific detail").
Output: `{ paragraphs: [string] }`. One attempt only, then ship.

---

## 6. Part C — code owns the envelope

### 6.1 Fields the model no longer writes

Today the prompt dictates these verbatim and then asks the model to echo them back. Code authors them:

| field | source |
|---|---|
| `name`, `tagline`, `contact` | `evidence.identity` (§4.3) |
| `date` | already computed (`today`) |
| `recipient` | `` `Hiring Team\n${job.company}` `` — two lines, no research-derived third line |
| `salutation` | `` `Dear ${job.company} Hiring Team,` `` (fallback `Dear Hiring Team,`) |
| `closing` | `Sincerely,` |
| `signatureTitle` | `` `${job.title} · candidate` `` |

Fewer tokens, no drift, and it retires a bug class: the literal-`\n`-escape test at
`scripts/tests/ai-models.js:1163` exists because a model hand-writes a field with an embedded newline.

**Do not change `buildCoverLetterDocument`'s input contract.** Assemble an object with exactly the
field names it expects today (`electron/ipc/resumeHtml.js:1496`). The builder, the editable-HTML sync,
and `scripts/tests/resume-download-bundle.js` must be untouched by this work.

### 6.2 Shape falls out of the plan

Today's "3-4 body paragraphs" is a shape the model pads to fill — itself a generator of average
letters. Derive it instead:

```
paragraphCount = 1 (thesis) + mappings.length + (companyHook.detail ? 1 : 0)
```

Three or four paragraphs still result, but because that is how much argument survived the gate. If
only one mapping clears the redundancy bar, the letter is three paragraphs and better for it. This is
the structural anti-padding measure and it is free.

### 6.3 Prompt content for the prose call

The cached prefix carries the editorial rubric plus two things the current prompt lacks.

**The reader model, stated first:**

> The recruiter is holding this candidate's résumé. They have already read it. Every sentence you
> write must survive the question: *the résumé already told me that — so what?*

**The positive space** — say what the letter *may* do, since it can no longer re-list:

1. Causal transfer — X demonstrates Y, which is what Z requires, and here is the mechanism.
2. Prioritization — of everything on that page, these one or two things decide this role.
3. Context the résumé's terseness destroyed — the constraint, why the number was hard.
4. Motivation and fit direction.
5. Cross-domain mapping, for a candidate whose résumé does not obviously match the posting.

**Contrastive examples.** The failure mode is distributional — the model is regressing to the mean of
a very large corpus of mediocre letters, and rules do not move a mode. Two or three *bad → good*
rewrites of the same sentence do, cheaply, and they cache. Write them against a domain unrelated to
any likely target job so they are not copied as content.

**Anti-form-filling**, to counter the split's one real risk: the plan is the argument skeleton, not
the sentences. Merge, reorder, and subordinate. Do not emit one paragraph per plan field in plan order
with the field values pasted in.

**Banned openers**, enforced by §7.4: "I am writing to express my interest", "I am excited to apply",
"I believe I would be a great fit".

### 6.4 Where the rubric lives

`getEditorialRubric()` (~line 142) reads **`SKILL.md` + `readme.md`** from
`Job Application Design System/` — **not `STYLE.md`**. Writing this standard into `STYLE.md` §11 would never
reach the prompt. If the standard belongs in the design system, it goes in `SKILL.md`; otherwise keep
it in code. Either is acceptable — just do not put it somewhere that silently never loads.

---

## 7. Part D — deterministic checks

New file `electron/ipc/coverLetterChecks.js`. **Pure functions only** — no Electron, no LLM, no `fs`
imports — so they are directly unit-testable under plain Node, matching the rationale already recorded
at `electron/ipc/jobApplication.js:157-161`.

Every threshold below is a **named exported constant** and a **first guess**. The fixtures (§10.2) are
how you tune them; do not treat these numbers as derived.

Each check returns `{ id, passed, detail }` where `detail` is a factual observation ("paragraph 2
shares a 14-word run with role 1 bullet 3"), never an asserted cause.

### 7.1 `checkEvidenceGrounding(plan, evidence)`
Every `mappings[].evidence` must match résumé text: a contiguous normalized shingle of ≥5 words shared
with some entry in `evidence.bulletTexts`, or ≥60% token overlap with one bullet. **This is the check
that makes §2 real** — it is what physically prevents career data from entering the argument.

### 7.2 `checkNeedGrounding(needs, jobText, researchText)`
Every `needs[].quote` must appear in the posting or research after whitespace/case normalization.
Catches invented requirements.

### 7.3 `checkRedundancy(paragraphs, evidence)`
Fail a paragraph that shares a contiguous run of ≥8 words with any bullet. Threshold is deliberately
high: *topical* overlap is correct and required — evidence must be checkable — and only phrase-level
copying is the defect. Do not "improve" this into a semantic similarity score; that would penalize the
letter for doing its job.

### 7.4 `checkGenericPhrases(paragraphs)` / banned openers
Blocklist: "writing to express my interest", "proven track record", "fast-paced environment",
"passionate about", "hit the ground running", "align with your values", "team player", "I believe I
would be a great fit", "dynamic environment", "wealth of experience". Plus the §6.3 opener rule applied
to the first sentence only.

### 7.5 `checkCompanySpecificity(paragraphs, researchText)`
Only when research was available. Requires at least one research-sourced specific beyond the bare
company name — a capitalized bigram, a four-digit year, or a figure that also appears in the research
text. Skipped, not failed, when research is unavailable.

### 7.6 `checkShape(plan, paragraphs)`
`paragraphs.length === expectedParagraphCount(plan)` per §6.2, and a total word budget
(`MAX_LETTER_WORDS`, start at 400).

### 7.7 `checkFigureDiscipline(paragraphs, evidence)`
Every numeric token in the letter must appear in the résumé text, and at most 3 figures total. A letter
that recites the résumé's numbers reads as padding — and the design doc's own §4.4 rationale ("any
figure the letter uses also appears in the résumé, where it carries a receipt") becomes structurally
true instead of instructed.

### 7.8 Page-count backstop
After `buildCoverLetterDocument` → `renderPdf`, read `pageCount`. `> 1` is a check failure. Today that
return value is dropped (~line 1359) even though the letter is already rendered — this closes an
existing gap rather than adding machinery. Note the existing rule from the résumé fit loop: a page
count measured with `fontsLoaded === false` is meaningless and must not be acted on.

---

## 8. Part E — gates and degrade policy

Never block the artifact. The tiers:

| stage | policy on failure |
|---|---|
| needs call throws / returns empty | **Degrade.** Proceed to the plan call reading the posting directly; record `needsAvailable: false`. |
| plan gate (§7.1, §7.2, `mappings.length < 1`, all mappings `resumeStatus: 'stated'`) | **Hard, one retry** with the violations named. Nothing user-visible exists yet, so strictness is free. If the retry also fails, proceed with the better of the two plans and record it. |
| prose checks (§7.3–§7.7) | **One revision call**, then ship regardless, recording unmet checks. |
| page count > 1 (§7.8) | Fold into the same single revision when one is already firing; otherwise one revision targeting length. |
| plan call throws | **Degrade** to a single-call letter using the plan schema's fields inline. Record it. A letter still ships. |
| prose call throws | Propagate as today — this one genuinely breaks the artifact. |

Worst case: 5 letter-related LLM calls (needs, plan, plan-retry, prose, revise).

---

## 9. Part F — telemetry and diagnostics

Extend the `applicationAttempt` snapshot (~line 1092) with:

```js
coverLetter: {
  needsAvailable, needsCount, topNeedArgued,   // boolean: did mappings use needs[0]?
  droppedNeeds: [{ need, reason }],
  mappingCount, planRetried, planRetryReason,
  checks: [{ id, passed, detail }],
  revised, pageCount,
}
```

Persist the **plan object itself** alongside `coverLetter` in the artifact snapshot (~line 1402) —
when a letter is bad, the plan is the small typed object that explains why. Keep the existing
`coverLetter: { salutation, recipient, paragraphs, closing, signatureTitle, contact }` shape intact and
add `coverLetterPlan` next to it; `electron/ipc/applicationSync.js` and the bug-report snapshot must
keep working.

**Diagnostics discipline:** report lines state observations, not asserted causes. "Shipped with 1
unmet check: no company-specific detail; research was unavailable" — not "failed because research was
unavailable." Mark truncation where it occurs.

User-visible surface: one modest line in the application workspace when checks were unmet. Do not build
a dashboard.

---

## 10. Part G — tests

New `scripts/tests/cover-letter-harness.js`, registered in `scripts/test-runner.js` and with its
dependencies re-exported from `scripts/test-dependencies.js` (that file is the single import surface
for the suites — see any existing suite's import line).

### 10.1 Unit tests (no LLM)

- **Extractor** against real `Job Application Design System/resume.html` markup: role/bullet/skill counts,
  annotation spans retained, `data-achievement-id` collection, identity fields.
- **Extractor decoy guard:** feed it a *built* document and assert it is not silently parsing the
  commented `<main data-print=…>` examples (§4.1).
- **Each check function** with a passing and a failing input.
- **`expectedParagraphCount`** across 1-mapping / 2-mapping / no-hook combinations.
- **Gate policy:** a plan with all `resumeStatus: 'stated'` triggers retry; a second failure ships
  rather than throwing.
- **Envelope authoring:** salutation/recipient/signatureTitle for a job with a missing company or
  title, and that the assembled object matches `buildCoverLetterDocument`'s expected field names.

### 10.2 Fixtures

`scripts/fixtures/cover-letter/` (that directory already exists and holds flat scraper HTML fixtures;
a subdirectory keeps these grouped) — `(careerData excerpt, résumé markup, JD, research)` tuples:

1. tight match;
2. **career changer** — the highest-value case;
3. thin JD, research unavailable — the degrade path;
4. a posting whose top-ranked need the candidate genuinely lacks. The honest question is whether the
   letter compensates with adjacent strength or starts begging.

### 10.3 Negative control — required

Run the grounding check with a plan whose `evidence` comes from **candidate A** against the résumé
evidence of **candidate B**, and assert §7.1 **fails**.

Without this we only ever prove the checks pass, never that they can fail — and a check that cannot
fail is decoration. Cheap to build (swap two fixtures), and it is the difference between a harness and
a ritual.

### 10.4 Manual app verification

The unit suite cannot exercise the LLM path. Before this is called done, generate a real application
from a real job card in the running app and confirm: both PDFs render, the letter is one page, the
letterhead matches the résumé's exactly, the plan appears in the bug-report snapshot, and the letter
does not restate résumé bullets. Several features in this pipeline shipped marked "NOT app-tested" —
this one should not join them on a quality claim nobody measured.

---

## 11. Non-goals — deliberately rejected

Each of these was considered and refused. Do not add them.

- **An LLM judge / scorer pass.** Converges on blandness: judges reward safe prose, which is the exact
  failure mode being fixed.
- **A separate "why this company" call.** Research already covers it; it is one field.
- **A polish/voice pass after prose.** That is the conditional revision (§5.4).
- **Semantic similarity scoring for redundancy.** Penalizes the letter for citing checkable evidence.
- **Tone or personality knobs.** The design system owns voice.
- **A longer letter.** Value here is per-word.
- **Letting the letter mine claims outside the résumé.** That is the whole design.

---

## 12. Invariants that must not regress

1. A cover letter always ships when the résumé does. No check, gate, or retry may prevent it.
2. `buildCoverLetterDocument`'s input contract is unchanged; the bundle, editable-HTML sync, and
   `resume-download-bundle` tests keep passing untouched.
3. Excluded skills from `skillInsights` are never named or implied in the letter.
4. The letter never claims the candidate is local, can commute, or will relocate unless career data
   says so.
5. Ledger `attribution: 'context'` items are never phrased as personal wins.
6. Cached prefixes stay byte-stable within a session.
7. The résumé path — mining, refute, résumé prompt, receipts, fit loop — is not modified by this work
   beyond the ordering change in §4.2.
8. The job listing and research remain wrapped by `wrapUntrustedText`. **New:** the résumé evidence
   block is model-authored *downstream of* attacker-controlled text (a crafted posting can influence
   résumé wording), so pass it inside its own labeled boundary — trusted as evidence, never as an
   instruction channel.

## 13. Acceptance checklist

- [ ] `extractResumeEvidence` + `renderResumeEvidenceForPrompt` land with tests, including the decoy guard.
- [ ] Letter generation moved after the fit loop; consumes final `mainHtml`; survives `pdfBytes: null`.
- [ ] Four tasks registered in all three `llm.js` maps and in `taskRoutes`.
- [ ] `LETTER_NEEDS_SCHEMA` and `LETTER_PLAN_SCHEMA` added; `APPLICATION_COVER_LETTER_SCHEMA` reduced
      to `{ paragraphs }`.
- [ ] Envelope fields code-authored; assembled object matches the builder's contract.
- [ ] Truthfulness section collapsed to the §2.1 axiom; the three §2.2 guards retained.
- [ ] Ledger input to the letter reduced to an id→attribution map; `serializeLedgerForPrompt` no longer
      on this path.
- [ ] `coverLetterChecks.js` pure, exported constants, all checks unit-tested both ways.
- [ ] Gate policy per §8, including every degrade path.
- [ ] Telemetry + persisted plan per §9; bug report and application sync still work.
- [ ] Negative control passes (i.e. fails as designed).
- [ ] `npm test` → 0 failed.
- [ ] Manual app run per §10.4.
