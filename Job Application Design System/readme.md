# Job Application Design System

An agent-only design system for generating staff/principal-level
engineering résumés — and their paired cover letters — from
structured candidate data + a target company / job description.
Both surfaces are in scope and ship from the same tokens, palette,
ink, and page geometry: a matched pair, not two systems.
Aesthetic: editorial-modernist,
developer-literate, quietly confident. Stripe Press book interiors,
Pentagram partner CVs, the body of `staffeng.com` and `lethain.com`
— that lineage.

The artifact has two jobs at once: **parse cleanly** in Greenhouse /
Ashby / Workday-class pipelines, and **signal high** in 6–10 seconds
of human skimming. Every decision in this system is in service of one
or both of those.

> **No human interactive surface.** No editor, no drag-drop UI, no
> CLI prompts. The agent reads the candidate's plaintext / markdown
> data + the job description, fills the HTML template, runs the
> PDF pipeline, and emits a single shippable PDF. End users see
> only the final artifact.

> **Mechanical decisions live in `STYLE.md`.** Token tables, type
> scale, spacing grid, page geometry, page-break rules. **Variant
> selection logic lives in `SKILL.md`** — the per-company decision
> rule the agent follows. This file holds philosophy, sources,
> content rules with examples, and caveats. If they ever disagree,
> `STYLE.md` is the source of truth for what the system *does*;
> `SKILL.md` is the source of truth for *how the agent uses it*;
> this file is the source of truth for *why*.
---

## Where the developer material lives

Build mechanics, the PDF pipeline, the file index, packaging, and the
system's provenance live in `ENGINEERING.md`. None of that is editorial
rule, and this file is read whole into every generation prompt — so it
stays out of here. What belongs here is *why the writing is the way it
is*.

The system covers exactly two surfaces — the printable résumé and its
paired cover letter (`STYLE.md §11`). No app UIs, no marketing, no
decks. Adding any of those is a *separate* design system; the
typographic restraint here doesn't generalise trivially.

---

## Content fundamentals

The voice of the artifact is **first-person implicit** — bullets
elide the subject ("Designed the sharding strategy…", not
"I designed the sharding strategy…"). This is universal résumé
convention and parses cleanly; switching to "I" or "you" breaks
both.

### Where education goes

There is **no Education section**. The degree rides in the header
subtitle, directly under the name:

> **Anya R. Castellanos**
> Staff Engineer · B.S. Computer Science, Carnegie Mellon University

The pattern is `[current professional role] · [highest completed
degree], [institution]`, as plain text inside `<main>` so every ATS
reads it. If the candidate has no documented degree, the subtitle is
the role alone — there is no alternate layout, no early-career
exception, and no toggle. The subtitle is never a specialisation
tagline ("Python backend, data integration & full-stack delivery"):
specialisation belongs in the bullets, where it comes with evidence.
Mechanics in `STYLE.md §5.8`.

### Casing & punctuation

- Section names are conventional and Title Cased: **Experience**,
  **Selected Systems**, **Skills**. Never
  capitalised "EXPERIENCE" in the source — the small-caps look is
  applied via CSS `text-transform: uppercase`.
- Sentence case in bullets. Capitalise proper nouns, products,
  protocols, services (Kafka, Postgres, gRPC, V8).
- Oxford comma. En dash for date and numeric ranges only
  (`Mar 2022 – Present`, `3–5 engineers`); `→` for a state change
  inside a bullet (`380 ms → 18 ms`).
- **No dash joins ideas.** See *Dash punctuation* below — it is the
  rule most often broken by generated copy, and the one that most
  reliably makes a résumé read as machine-written.
- Numerals: digits for everything quantitative. **Always** include
  the unit (`38 ms`, not `38`). Figures are proportional, not tabular —
  tabular figures (`tnum`) break PDF text extraction, so they are
  disabled system-wide (see STYLE.md §2.4); column alignment comes from
  the grid, not the digits.
- Tech terms are inline `<code>` only when the term is something
  you'd type, not when it's a product name. `kubectl apply` → code;
  Kubernetes → not code.

### Dash punctuation

A dash may live **inside a word or a value**. It may never **connect
ideas**. The rule covers every piece of candidate copy: résumé
bullets, role summaries, project descriptions, annotations, and every
sentence of the cover letter. Mechanical detail and the audit step are
in `STYLE.md §5.3.1`.

**Allowed**

- Hyphenated compounds: `app-side`, `one-page`, `end-to-end`,
  `11-month`
- Technical names that carry the hyphen: `consistent-hash`,
  `snapshot-restore`, `us-east-2`
- Email addresses, URLs, slugs: `anya@castellanos.dev`,
  `linkedin.com/in/anya-castellanos`
- Date and numeric ranges, en dash: `Mar 2022 – Present`,
  `3–5 engineers`

**Forbidden**

- Em dash joining clauses, introducing an explanation, or hanging an
  afterthought off a sentence, including em dash pairs used as
  parentheses
- En dash used as sentence punctuation rather than as a range
- Hyphen-minus standing in for an em dash or a parenthetical connector

**Reject, then rewrite**

| Reject | Write instead |
|---|---|
| "Led the migration — reducing p99 latency by 40%." | "Led the migration, reducing p99 latency by 40%." |
| "Improved the system — and reduced operating cost." | "Improved the system and reduced operating cost." |
| "I am interested in this role – it aligns with my experience." | "I am interested in this role because it aligns with my experience." |
| "The project succeeded - despite the initial constraints." | "The project succeeded despite the initial constraints." |

Why the rule is this strict: the joining dash is the single loudest
tell of generated prose, and it is also lazy. It lets two ideas share
a sentence without deciding how they relate. A comma, a semicolon, a
colon, a conjunction, parentheses, or a full stop each state the
relationship. (A colon used for one explanatory clause is still
fine; a colon introducing a list of three or more items is a
separate, forbidden pattern — see the cover-letter honesty section
below.) Where the material being joined is *structural* rather
than prose (a role summary's label and value, an annotation lead-in),
the system's separator is the mid dot: `Storage platform · tech lead,
team of 8`.

### Bullet ordering: relevance to the job, not chronology

Before ordering, each bullet must survive being read alone. Recruiters and ATS
previews often surface one `<li>` without its neighbors, so a bullet cannot
borrow its subject from a preceding bullet or role summary. Repeat the shortest
clear noun phrase for the platform, database, system, dataset, or actor; reject
backward references such as "those platforms" and "that database." Apply the
same document-wide copy edit to compounds such as "in-house." Data-flow copy
names its actors instead of using "their APIs" or "data they returned," and
temporal modifiers such as "after testing" sit beside the action they modify.

The same role's bullets get **re-sequenced for every application.**
Within a role, the first bullet is the one whose evidence most
directly answers *this* job description — its responsibilities,
named technologies, business problem, seniority signals, and the
kind of outcome it seems to value — never the one that happened
first, never the one that mattered most to the past employer, and
never just the one with the biggest number. Reordering only changes
position: the facts, numbers, and scope of a bullet never change to
fit an application, and a bullet never gets promoted to imply a
relevance it doesn't have. Mechanics in `STYLE.md §5.3.2`.

### Cover letter opening (hard gate)

The letter's first sentence must hand the recruiter something useful
immediately: a job-specific thesis, a concrete evidence-to-need
connection, or a supported observation about the company's work that
establishes the candidate's direction. It must never open by
announcing the document's purpose or the act of applying — "I am
writing to apply…", "I'm writing to apply…", "I am applying for…",
"I am writing to express my interest…", "Please accept my
application…", or any equivalent throat-clearing. The recruiter
already knows this is an application; the ATS submission, the
filename, the job record, and the company-specific salutation already
say so. The company and role name are still allowed in the opening
when they're doing real work inside the thesis — the rule bans the
announcement, not the words. Full rule, the reject/rewrite table, and
the audit grep are in `STYLE.md §11.2.2`.

If the opening first names an unfamiliar prior employer, it also states the
candidate's role or relationship there. Do not begin with an unexplained
organization-first construction as though the recruiter already knows it. Across
the rest of the letter, name cross-domain evidence by its concrete software,
system, or responsibility; a possessive industry label can imply unsupported
domain breadth or a different job function.

The closing names the experience, skills, or work the candidate would bring.
Those capabilities support the argument; they are not themselves "the
evidence" brought to the role.

### Colon dumps, overloaded sentences, metaphors, broken parallelism, unearned generalization

Five prose failures are banned in **every** string the system
writes — résumé bullets, role summaries, project descriptions, and
every sentence of the letter. A colon whose right-hand side is three
or more parallel items is a keyword list, not an argument: name the
technologies where they carry the claim, and let the verbs state how
the pieces relate. A sentence that stacks several independent
systems, a qualification, and a conclusion should be split so each
sentence makes one point the next can build on. A figure of
speech reused across sentences or paragraphs as connective tissue
should be replaced with the literal description of ownership,
integration boundary, or data flow. And a coordinated construction —
`from X through Y`, `both X and Y`, `either X or Y`, `not only X but
also Y`, or a list — must keep its paired elements in the same
grammatical form. A noun phrase paired against a gerund phrase should
become two noun phrases or two actions. Padding the seam does not repair the
mismatch; it only hides it. And a concluding or transitional sentence
must stay inside the evidence that earned it and name what it
generalizes: one example or one role supports a claim about that
example or that role, never "most of my work" or "throughout my
career", and a summary noun ("shape", "pattern", "approach") has to
define the concrete responsibility, system, decision, or process it
stands for in the same sentence. These are defects of *shape*, so
test a draft structurally rather than against a list of words.
Rules and repairs: `STYLE.md §11.2.3`.

A parallel pair can still be opaque: do not compress a multi-step workflow
into an endpoint range. State the supported actions directly.

### Cover letter honesty and synthesis (hard gate)

Being honest about qualifications means not exaggerating — it does
not mean volunteering what the candidate hasn't done. Reject any
clause whose purpose is to name the boundary of the candidate's
experience, in whatever words; when the candidate has adjacent
experience, make the transferable understanding the subject of the
sentence and state concretely what that work required them to get
right, without claiming it's the same thing. Only name a gap when the
application explicitly asks or omission would be materially
misleading.

Four more failure modes travel with that one: a colon whose right-hand
side is three or more parallel items reads as pasted résumé keywords,
not argument — convert it into sentences whose verbs carry the
relationships. An overloaded sentence that stacks several
systems, qualifications, and a conclusion into one clause-chain
should split into separate sentences, each making one point the next
can build on. Avoid a figure of speech reused across paragraphs as
connective tissue — prefer literal description of ownership and data
flow, and save figurative language for the rare sentence where it's
doing real work. And a coordinated phrase must keep both sides in the
same grammatical form — a `from X through Y` span that pairs a noun
phrase against a gerund phrase is the most common break, repaired by
putting both ends in the same form.

The letter is also the one surface with paragraph boundaries, and the
gate covers them. A conclusion may generalize from the evidence above
it only when it names the concrete responsibility, system, decision,
process, or mechanism connecting that evidence, and only as wide as
that evidence goes. A paragraph that opens by pointing back with
"this", "that", or "it" must have exactly one plausible antecedent;
when the previous paragraph offered several possible referents, repeat the
precise noun phrase instead. Repair a
detached synthesis by rewriting it as a concrete, evidence-scoped
conclusion or by cutting it; a filler transition that names nothing
leaves the ambiguity in place and costs a line.

The letter should read as a small number of well-argued examples —
what the candidate built, the problem it solved, why it matters to
this role — not a résumé's bullets converted into paragraph form.
The full rules are stated as sentence *shapes* rather than sample
copy, on purpose: `STYLE.md §11.2.3`.

Source material supplies facts, not mandatory prose wording. Provenance-bearing
category labels are part of those facts: personal, open-source, academic,
volunteer, and employer-owned projects must keep their stated attribution.
Preserve the evidence boundary while paraphrasing distinctive constructions
across the résumé and letter; do not repeat “built from scratch” when a plain
supported verb such as “created” or “designed and implemented” does the job.
State why a new employer, project, or period belongs before its details. Do not
use “now,” “still,” or a similar temporal contrast without stating the other
side of the contrast.
Prefer ordinary contemporary wording (“closed the gap,” not “answered the
gap”), and name a prior employer once before using the role, system, or “there”
when the reference is clear. Narrow evidence-derived connective language is
part of good synthesis; invented candidate facts are not.

### Tone

Specific, structural, unhyped. **Numbers and trade-offs**, not
adjectives. A bullet that says "scalable, high-performance"
contains zero information; the same bullet rewritten as
"1.4M QPS at p99 38 ms, replacing the consistent-hash scheme that
misbalanced under tenant skew" contains four pieces of usable
signal (scale, latency, prior approach, why it failed).

### What to include in a bullet (in order of skim priority)

1. **The scale number.** QPS, p99, $-volume, team size, tenants,
   PB, % change. If you can't find a number, the bullet is weak.
2. **The decision or change.** "Replaced X with Y" / "Migrated
   from A to B" / "Designed N for M".
3. **The trade-off, if it's a real one.** What you gave up to get
   the win — only when there was a genuine fork in the road (CRDT vs.
   Raft, build vs. buy), stated as a one-clause `.tradeoff` annotation.
   Not every bullet has one, and reaching for the annotation to
   compensate for a missing number, or letting it balloon a two-line
   bullet into a paragraph, is the failure mode it's most often abused
   for (`STYLE.md §5.4`).
4. **The scope of ownership.** Lead, owner, IC, mentor.

That's what goes inside a bullet. Which bullet goes first within a
role is a separate decision — see "Bullet ordering" above; never let
raw metric size or chronology decide it.

### What to leave out

- The candidate's **location, unless it was explicitly supplied as
  contact data.** Never infer a city from the job posting, the
  employer's HQ, a prior office, a school, an area code, or a
  timezone — omit the field instead (`STYLE.md §9.1`). The shipped
  samples run a two-item contact line, **email · phone**, which is
  complete on its own; location and one canonical URL are optional
  additions, not expected fields.
- Adjectives without numbers ("scalable", "robust",
  "world-class").
- Soft-skill claims that nobody can verify ("strong
  collaborator").
- Acronyms without expansion on first use, unless the acronym is
  load-bearing in your subfield (Raft, CRDT, V8 are fine; bespoke
  internal product names are not).
- Emoji. Ever.
- Skill bars, progress dots, percent-mastery scales.

### Examples

> ✔ Designed the sharding strategy for the timeseries write path,
> sustaining **1.4M QPS** at **p99 38 ms** across a 19 PB dataset;
> replaced the prior consistent-hash scheme after it misbalanced
> under tenant skew.

> ✘ Designed scalable, high-performance sharding for a massive
> timeseries workload using cutting-edge approaches.

> ✔ Built an internal review agent on Claude Code that summarizes
> PR diffs against the platform contract; cross-team review cycle
> dropped from **3.2 → 0.7 days** median, adopted by 4 sibling teams.

> ✘ Leveraged AI to improve developer experience and productivity.

> ✔ Cut cold-start time from **380 ms to 18 ms p95** by snapshotting
> the isolate heap, then trading 40 MB of resident memory per node for
> the win.

> ✘ Cut cold-start time from **380 ms to 18 ms p95** — snapshotting
> the isolate heap — and traded memory for the win.

The second version says the same thing with the dashes doing the
thinking. Both dashes are forbidden (`STYLE.md §5.3.1`).

---

## Visual foundations — at a glance

A one-paragraph orientation. Full rules in `STYLE.md`.

The page reads as **ink on warm paper** — flat `#F7F4ED` ground,
deep warm near-black body, **one** restrained accent (oxblood
`#7A1F2B`) used only on the candidate name. Three families:
**Source Serif 4** for the name only, **Inter** for everything
else, **IBM Plex Mono** for inline `<code>` and the project-metrics
line. Body at **10.25 pt** / 1.45 / ~70–75 chars per line (that figure is
running prose — a bullet's own renderer-verified budget, one number
for every bullet whether annotated or not, is `STYLE.md §5.4`).
Section headers are 9 pt uppercase tracked +0.14 em with a hairline
rule filling the line. 4 pt spacing grid. **No icons, no skill bars, no
progress dots, no photo, no cards, no shadows on the page, no
gradients, no rounded corners, no emoji.** The only typographic
flourish is the candidate name. See `preview/anti-patterns.html`
for what's explicitly out of bounds.

---

## Variants

Four opt-in variant attributes, **all valid only on the root
`<html>` element** — an attribute on `<main class="page">` or any
other ancestor is ignored. Full mechanical details in
`STYLE.md §10`; the agent's per-company decision rule for which to
apply lives in `SKILL.md — §Variant selection`. Variants compose
freely, except the two `data-print="…"` values which are mutually
exclusive.

| Toggle (on `<html>`)                   | Effect                                                      |
|----------------------------------------|-------------------------------------------------------------|
| `data-page="a4"`                       | Recomputes margins for A4 stock and routes the page to the `@page a4` rule (or `@page a4-compact` when compact is also set) via CSS named pages. |
| `data-mono`                            | Rebinds `--accent-on` to `--ink-1`. Candidate name renders in ink. |
| `data-density="compact"`               | Tightens body type, leading, block-spacing, and head/foot margins to claw back 6–9 lines per page. The system's one measured-fit fallback — applied only *after* a render shows overflow, never the default. |
| `data-print="ink-only"`                | Single-state white-paper PDF. Keeps the warm cream on screen, flips to pure white only when printing. Oxblood name preserved. |
| `data-print="dual-pdf"` *(default)*    | Dual-mode PDF. After post-processing through `build/dual-mode-pdf.js`, the resulting PDF shows cream on screen and prints on white — same single file, different states. |

**Host-driven consumers.** When a host app owns the document shell
(**Infinite Canvas** is the reference consumer), the generated output
is exactly a bare `<main class="page">…</main>` with no `data-*`
variant attributes. The host sets the root attributes, renders
default density first, and enables `data-density="compact"` only
after measuring an overflow.

## PDF generation

`data-print="dual-pdf"` is the default in `resume.html`. The agent-facing
pipeline — including the gates to run before rendering — is `SKILL.md
§The pipeline`; the module, flags and self-tests are in
`ENGINEERING.md`. The per-company rule for which variant to apply is
`SKILL.md §Variant selection`.

Pages 2+ print a mono page indicator (`2 / 3`) at the bottom right via
CSS `@page` margin boxes. Page 1 is suppressed so a one-pager never
shows a counter. See `STYLE.md §10.6`.

---

## Iconography substitution flag

The system ships **zero icons**, by design — see `STYLE.md §7`.
If a future client absolutely requires icon-augmented sections
(e.g. a small mail glyph beside the email address), recommend
**Heroicons outline** (24 px, 1.5 px stroke) over CDN as the
closest match in stroke weight and reserve. Document the addition
in `STYLE.md` if you ship it.

---

## Caveats

- The system covers exactly two surfaces — the résumé and its
  paired cover letter. Don't
  generalise the typographic restraint to apps, marketing, or
  decks; make a separate system for those.
- The screen preview wraps the page in a warm gradient so the
  artifact reads as paper. The print stylesheet strips this. If
  you screenshot for a Figma or marketing context, screenshot at
  print scale (1:1) rather than the screen preview.
- For browsers that strip background colours when printing, the
  `print-color-adjust: exact` declaration in `colors_and_type.css`
  forces colour through to the PDF — critical for the oxblood
  candidate name. If your render pipeline overrides this, the
  accent collapses to black. Test before shipping.
- The candidate name shrinks gracefully on narrow viewports
  (mobile screen preview) via a `clamp()` keyed to viewport width.
  This is **not** long-name handling — a very long name on a
  desktop viewport still renders at 28 pt and may overflow. If
  the name doesn't fit, edit the content (use initials, drop a
  middle name); the CSS will not protect a 35-character name from
  the right margin.
