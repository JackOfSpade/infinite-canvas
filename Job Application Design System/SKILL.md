---
name: job-application-design
description: Use this skill to generate editorial-modernist, developer-literate résumés — and their paired cover letters — for staff/principal-level engineers and adjacent senior individual contributors. Input is structured candidate data (plaintext / markdown experience, projects, skills, highest completed degree, contact info) plus a target company / job description. Output is a print-ready PDF tuned to the recipient.
---

# Job Application Design System

A polished, opinionated visual template for senior IC résumés and their
paired cover letters. Both surfaces are in scope and ship from the same
tokens, palette, and page geometry — a matched pair, not two systems. The
system is **agent-only**: there is no human-facing UI, no manual
build step, no interactive editor. An agent reads candidate data +
a job description, fills the HTML template, generates the PDF, and
post-processes it into the right print variant for the recipient.

## Files in this skill

| Path                          | Role                                                                                |
|-------------------------------|-------------------------------------------------------------------------------------|
| `STYLE.md`                    | The full design specification. **Read this first.** Every rule, with rationale.    |
| `readme.md`                   | Philosophy, content rules, system caveats, anti-patterns.                          |
| `ENGINEERING.md`              | Developer material — file index, PDF mechanics, test wiring, packaging, provenance. Deliberately **not** part of the editorial rubric. |
| `styles.css`                  | Global entry point — re-exports the token closure.                                 |
| `colors_and_type.css`         | Design tokens — colour, typography, spacing, page geometry, all variants.          |
| `resume.css`                  | Components — page chrome, header, sections, roles, bullets, projects, skills. |
| `resume.html`                 | The résumé template + a fully-populated layout fixture. Reuse its structure, never its facts, wording, sentence shapes, or domain framing. |
| `cover-letter.css`            | The letter surface (serif body, date / salutation / close, no recipient block). Load after `resume.css`. |
| `cover-letter.html`           | The paired cover-letter layout fixture. Reuse its structure and geometry, never its prose.           |
| `build/dual-mode-pdf.js`      | Pure module exporting `addOcgBackground(bytes) → bytes`. UMD; loads in Node or browser. |
| `build/test.js` · `build/browser-check.html` | Self-test for the dual-mode PDF module: `test.js` is wired into `npm test`; `browser-check.html` is the **manual** browser-path companion. |
| `build/annotation-typography-test.js` | Typography regression: the inline `.scope` / `.tradeoff` / `.annotation-label` spans must inherit the owning bullet's type, and `.tradeoff` must not be italic (STYLE.md §5.4). Static; no browser needed. |
| `build/annotation-budget-test.js`     | Restraint + length regression: at most one annotation per bullet (one `.tradeoff` max), and every bullet — annotated or not — stays under the 180-visible-character budget so a `.tradeoff` can't substitute for evidence or turn a bullet into a paragraph (STYLE.md §5.4). Static; no browser needed. |
| `build/bullet-length-check.html`       | **Manual** browser check behind that budget: renders worst-case bullet text at 180/100 characters in the real page structure (Letter/A4 × default/compact) and asserts each holds ≤ 2 wrapped lines (STYLE.md §5.4). Open it in a browser — nothing runs it for you. |
| `build/parallelism-gate-doc-test.js` | Static doc regression for the §11.2.3 Rule 5 parallel-construction gate: fails if the failure-mode count reverts to four or five, the coordination shapes (`from X through Y`, `both`/`either`/`not only`) or the general same-form repair are dropped from `STYLE.md`, or the résumé-facing enumerations in `SKILL.md`/`readme.md` regress to covering only colon-dumps/overloaded-sentences/metaphors. No browser needed. |
| `build/synthesis-scope-gate-doc-test.js` | Static doc regression for the §11.2.3 Rule 6 earned-generalization gate: fails if the failure-mode count reverts, or if `STYLE.md`/`SKILL.md`/`readme.md` drop the evidence-scope requirement, the named-connector requirement, the bridge-noun clause, the one-antecedent rule at paragraph boundaries, the rewrite-or-delete repair, or the "filler is not a repair" prohibition. No browser needed. |
| `build/bullet-redundancy-gate-doc-test.js` | Static doc regression for the one-accomplishment-one-bullet rule: fails if `STYLE.md §5.3`, `SKILL.md`'s "Do not let one bullet restate another" section and its negative-space line, or `readme.md`'s "Bullet ordering" section drop the combine-into-one-bullet repair, the cross-reference to "Do not let a project section restate the bullets," the "subject is the previous bullet's object" tell, or the never-split-to-fill-a-page rule. No browser needed. |
| `build/ats-parse-test.js`     | Parse-safety gate (STYLE.md §8.1): fails on tables, imagery in `<main>`, absolute positioning, CSS columns, hidden text, tabular figures, `&nbsp;` in copy, contact outside `<main>`, and reading-order inversions. Takes file paths; defaults to the shipped samples. |
| `build/education-placement-test.js` | Static regression: no Education section anywhere, and the degree rides in the header subtitle (STYLE.md §5.8). Wired into `npm test`. |
| `build/page-policy-doc-test.js` | Static doc regression for the one-page default and its explicit-override language (STYLE.md §6 · pipeline step 5). Wired into `npm test`. |
| `build/token-sync-test.js`    | Sync gate for every place a token value is restated as a literal: the PDF module's cream default, the four `@page` footers and margin pairs, STYLE.md §3.1's colour table, the preview cards and thumbnail. |
| `build/harness.js` · `build/css-tokens.js` | Shared assertion harness; token reader — so no test hardcodes a token value. |
| `build/MANUAL-CHECKS.md`      | The eight `*-check` browser fixtures (including `annotation-typography-check.html`): what each measures, when to run it, and why nothing automates them. |
| `build/vendor/` (removed)     | pdf-lib 1.17.1 now loads from CDN (browser) / the `pdf-lib` npm package (Node) — no longer vendored. |
| `fonts/` (removed)            | Source Serif 4, Inter, IBM Plex Mono now load from the Google Fonts CDN — no longer bundled. |
| `preview/`                    | Standalone preview cards for each design subsystem. Reference material only.       |
| `handoff/`                    | Frozen developer handoff for the paginated screen preview. Reference only; no shipped code reads it. |

## The pipeline

End-to-end, given candidate data + job description:

1. **Parse candidate data.** Extract: name, contact (email and
   phone; optionally a supplied location and at most one canonical
   URL, site OR github, never both), 3–6 role entries
   with titles + companies + dates + each role's stated work
   location + 3–6 bullets each, an optional source-accurate project
   category (for example, "Personal Projects", "Open Source", or
   "Selected Systems"), a skills block, and the highest
   **completed** degree + institution (they go in the header
   subtitle — there is no Education section; `STYLE.md §5.8`).
   Apply the content rules in `STYLE.md §5` aggressively — kill
   adjectives without numbers, demand a scale number or trade-off
   in every bullet.

   **Location is optional and privacy-gated.** Include the
   candidate's city/region in the contact line **only when it was
   explicitly supplied as candidate contact data.** Never infer or
   backfill it from the job posting, the employer's headquarters, a
   prior role's office, a school, an area code, a timezone, or any
   other context. If it was not given, omit the
   `addressLocality` span entirely — a contact line of email · one
   URL is complete and correct. The same rule applies to the cover
   letter's letterhead.

   **Per-role `.role-location` is the opposite case and must not be
   confused with it.** It is an employment fact, and it is **required
   whenever the source data states a location for that role** — reading
   it off that role's own entry is not an inference, so this rule never
   licenses the candidate-contact location above. Extract it alongside
   the title, company and dates in step 1. Fold it into `.role-dates`
   by default (`STYLE.md §5.2b`) — a role with no summary to share the
   second row costs a full line for nothing by giving the location its
   own `.role-meta` row instead. Keep the `.role-meta` row only where
   the fold doesn't apply: a summary shares the row, or the location
   can't parse back out of the dates cell. A location is never dropped
   to buy a line.

2. **Read the job description.** Identify:
   - Company name and the *kind* of company (see decision table below)
   - Role level (staff, principal, senior, IC4+) — confirms the
     system is being used in its target band
   - Any explicit format requirements (one-page, A4, B&W, etc.)

3. **Choose variants** by company / industry signal. The full
   decision rule is `## Variant selection` below — read it before
   filling the template. The chosen variants become attributes on
   the root `<html>` element, and nowhere else.

4. **Fill `resume.html`** with candidate content following the
   structural conventions in `STYLE.md §4–§7`. Preserve the existing
   semantic markup; do not invent new component shapes. Use the
   `.scope` cell for role ownership, `<strong>` to mark scale numbers
   inside bullets (semantic metadata only — it renders at the bullet's
   own weight, not bold: STYLE.md §5.4.1), and `.tradeoff` **sparingly** — only for a
   genuinely decision-defining alternative or constraint, never as an
   automatic stand-in for a bullet that lacks a hard metric, and never
   past the length budget in `STYLE.md §5.4`. Most bullets should ship
   with no annotation at all.

   **Order each role's bullets by relevance to this job, not
   chronology.** Re-sequence per application: the first bullet in a
   role is whichever one most directly answers this job description's
   responsibilities, named technologies, business problem, and
   seniority signals — never the most recent, never the one that
   mattered most to the past employer, and never just the one with
   the biggest number. Reordering never changes a bullet's facts or
   invents relevance a bullet doesn't have. Full rule: `STYLE.md
   §5.3.2`.

   **Make every highlight bullet self-contained.** A recruiter or ATS
   preview may read any `<li>` without its neighbors. Name the concrete
   platform, database, system, dataset, or actor inside that bullet; never
   rely on a preceding bullet or role summary through backward references
   such as "those platforms" or "that database." Repeat the shortest clear
   noun phrase instead. In data-flow copy, name the producer, consumer,
   vendor, agency, database, or platform instead of "their APIs" or "data they
   returned." Keep "before" and "after" beside the action they modify.

   **Prose fields obey the synthesis rules too.** Role summaries and
   project descriptions are subject to `STYLE.md §11.2.3` exactly as
   the letter is: no colon followed by an inventory of technologies,
   no sentence stacking several systems and a conclusion, no reused
   metaphor doing connective work, no coordinated phrase — a
   `from X through Y` span, a `both`/`either`/`not only` pair, a list —
   whose two sides shift grammatical form (a noun phrase spliced to a
   gerund phrase is the most common case), and no conclusion wider
   than the evidence under it. One role's summary may generalize about
   that role; it may not generalize about "most of my work" or a
   career, and a summary noun ("shape", "pattern", "approach") must
   name the responsibility or sequence it stands for in the same
   sentence.
   Do not compress a multi-step workflow into an opaque endpoint range; name
   its supported actions directly.

   **Facts are binding; source wording is not.** Preserve the evidence and its
   scope while varying distinctive constructions across the résumé and cover
   letter. Establish why a new employer, project, or period belongs before its
   details; never use a temporal contrast such as “now” without stating the
   contrasted state. Prefer common contemporary verbs (“closed the gap,” not
   "answered the gap"). Do not repeat a prior employer’s full name merely from
   habit. Within a paragraph, continue naturally with `I` when the candidate
   remains the subject. At a new paragraph, use `In that role` when it helps
   identify the continued role, and omit it when the continuation is already
   clear; repeat the name when multiple employers or roles make a reference
   ambiguous. Narrow connective or causal language
   entailed by the evidence is allowed for cohesion; new candidate facts are not.
   Treat an employer, team, product, or operational assertion that comes only
   from the job listing as the listing's description, not as independently
   verified fact. Frame its source plainly; use an unqualified assertion about
   the employer only when reliable research verifies it, without turning the
   attribution into repetitive hedging. Discuss target scope as `this role` or
   the work itself; do not use impersonal `the listing describes` framing for
   ordinary role responsibilities. Use listing attribution only when it
   establishes the provenance of an unverified employer or company assertion.
   Make the source document, not the target position or work being described,
   the grammatical subject of any required reporting verb. Refer to the
   position attached to the application with a proximal determiner unless
   explicitly contrasting it with another role.
   Read every sentence once as a recruiter seeing it for the first time. Reject
   idiom, figurative personification, or an implied actor, artifact, or action
   when the reader must translate it or reconstruct what it literally means.
   Also inspect each clause boundary: if adjacent words form a familiar compound
   or alternate parse that a reader may take first, recast the sentence instead
   of using punctuation to force its intended grammar. In interface or ownership
   claims, name the concrete actor, artifact, and action instead. Each named
   technology needs a governing verb that reflects its actual role; never group
   tools with distinct roles under one operation. Reject a bridge sentence that
   merely restates a category without adding a decision, mechanism, constraint,
   or result.

   Give each cover-letter paragraph one argumentative job, not a prescribed
   number of sentences. Use as many sentences as clarity requires. Split
   separate claims, action steps, or relevance links when combining them makes
   the grammar harder to follow. In particular, an artifact may be introduced
   in one sentence and its supported trigger or follow-up action explained in
   the next. Do not force a feature inventory into the introduction, and do not
   add a standalone abstract sentence merely to label the work's difficulty or
   "problem shape." Explain the evidence-to-role connection only when the proof
   and transfer do not already make it clear.

   **Project-category provenance is binding too.** A heading that identifies
   work as personal, open-source, academic, volunteer, or employer-owned is a
   factual attribution, not disposable source wording. Preserve that category
   for every retained project. In particular, source-labelled `Personal
   Projects` must remain `Personal Projects`; choosing only some entries never
   licenses `Selected Projects`, `Projects`, or `Selected Systems`, because
   those labels erase the distinction from paid work.
   When the letter's opening first names an unfamiliar prior employer, identify
   the candidate's role or relationship in the same sentence rather than opening
   with a bare "At [employer]." Describe cross-domain evidence through the
   concrete software, system, or responsibility; never use a broad possessive
   industry label that can imply unsupported domain or operational scope. In the close, say which
   experience, skills, or work the candidate would bring; do not call the
   capabilities themselves "the evidence" brought to a role.

   **The header subtitle** is `[current professional role] ·
   [highest completed degree], [institution]` — e.g. `Staff Engineer
   · B.S. Computer Science, Carnegie Mellon University`. Role in
   `.tagline .subtitle-role` (never `.role` — that class is the
   Experience block component), credential in `.tagline .credential`,
   joined by the mid-dot `.sep`. **No documented degree ⇒ render the role
   alone** and delete the separator and `.credential` span; never add
   an Education section, and never write a specialisation tagline
   ("Python backend, data integration &amp; full-stack delivery") in
   its place. Full rule: `STYLE.md §5.8`.

   **Then run the dash gate.** Every string written in this step is
   subject to `## Dash punctuation` below: no em dash anywhere, no en
   dash outside a date or numeric range, no spaced hyphen. Run the
   three greps in that section against the filled HTML (and against
   the filled `cover-letter.html`) before continuing to step 5. A
   joining dash is the loudest tell of machine-written copy, and it
   survives into the PDF where nothing downstream will catch it.

   **Then run the evidence-synthesis gate — cover letter only.**
   `STYLE.md §11.2.3` bans six sentence shapes in the filled letter:
   a clause whose job is to name a boundary of the candidate's
   experience instead of stating the adjacent strength positively; a
   colon whose right-hand side is three or more parallel items; a
   sentence combining several independent systems, a qualification,
   and a conclusion; a figure of speech repeated across paragraphs to
   carry transitions; a coordinated construction (`from X through
   Y`, `both X and Y`, `either X or Y`, `not only X but also Y`, or a
   list) whose paired elements don't share a grammatical form — most
   often a noun phrase spliced to a gerund phrase; and a concluding or
   transitional sentence that generalizes past the evidence under it
   or without naming the concrete responsibility, system, decision,
   process, or mechanism that connects it (one example or one role
   becoming "most of my work" or "throughout my career"; a bare
   "shape", "pattern", or "approach" left undefined; a paragraph
   opening on "this", "that", or "it" with more than one plausible
   antecedent). Judge by shape, not by
   phrase list — these are structural defects that survive any
   rewording, so this is a required close read of the letter body,
   not a keyword scan. Two structural greps are worth running as
   triage:

   ```sh
   grep -noE ': [A-Za-z][^.]*, [^.]*, and ' filled.html   # colon → 3+ item list
   grep -noiE 'most of my work|throughout my career|my (general )?(working )?(style|approach)|(the|a) (shape|pattern|throughline) (of|my|most)' filled.html   # breadth past the evidence
   ```

   They catch two of the six; read every paragraph for the rest, and
   read every paragraph's first sentence specifically for the
   one-antecedent test. Repair a detached synthesis by rewriting it as
   a concrete, evidence-scoped conclusion or by deleting it — never by
   inserting a filler transition ("That said", "Additionally", "In
   this way"), which leaves the reference just as ambiguous.
   Evidence should read as two or three well-argued examples, not a
   résumé converted to prose.

   **Then read the final sentence as a role-facing invitation.** If it invites
   a conversation, it must connect the candidate's relevant contribution to the
   target work. The sentence graded is the paragraph's final *substantive*
   sentence — a trailing courtesy line (`Thank you for your consideration.`,
   `I am available at your convenience.`) carries no invitation of its own and
   is skipped when finding it, so a letter that ends on one of those still has
   to satisfy this rule on the sentence before it. Do not end solely on what
   the candidate wants to learn, hear, or discuss. Keep the invitation direct
   and present-tense, without conditional or deferential boilerplate:
   `I welcome a conversation` is direct; `I would
   welcome a conversation` or `I would welcome a discussion` is not.
   The check reads three things in that sentence: the candidate's asset has to
   be named by a possessive, an authorship clause, or a demonstrative carrying
   its own descriptor (`my integration work`, `the connector I built`, `that
   MCP server experience` — never a bare `that work`); the sentence has to
   say what the asset does (`... could support ...`, `... supports ...`,
   `applying ... to ...`); and the sentence has to reach the employer's own
   side of that action with an explicit target — `your ...`, `the`/`this`
   plus a work noun (`the platform`, `this team`), a reader noun
   (`customers`, `users`, `clients`), or the employer's own name. A sentence
   that names only the candidate's asset and what it does, with no
   employer-facing target in that same sentence, does not pass — however
   specific the asset is.

   **The letter's opening sentence is a hard gate.** `STYLE.md §11.2.2`:
   the first sentence must lead with a job-specific thesis, a concrete
   evidence-to-employer-need connection, or a supported observation
   about the company's work — never an announcement that this is an
   application. The recruiter already knows that from the ATS
   submission, the filename, and the salutation above it. Reject and
   rewrite any opening built on "I am writing to apply…", "I'm writing
   to apply…", "I am applying for…", "I am writing to express my
   interest…", "Please accept my application…", or an equivalent —
   swapping in a synonym doesn't pass, only leading with substance
   does. The company and role name may still appear in the opening
   when they're load-bearing inside the thesis itself; they just can't
   appear only to announce the application. Grep before rendering:

   ```sh
   grep -niE "writing to apply|writing to express my interest|^i am applying for|please accept my application" filled.html
   ```

   **The letter date is never typed in.** `cover-letter.html` fills it
   from the system clock at render time (month + year, plus the
   `datetime` attribute) — see `STYLE.md §11.6`. Leave that element
   and its inline script alone; if your pipeline renders without
   JavaScript, substitute the current month yourself at fill time.

   **Then run the annotation-budget gate.** Run
   `node build/annotation-budget-test.js <filled.html> <filled-letter.html>`
   — it takes file paths as arguments and defaults to the shipped
   samples, so **pass the candidate's documents explicitly**. With no
   arguments it re-checks the two shipped templates and tells you
   nothing about this application.
   It fails on more than one annotation per bullet, more than one
   `.tradeoff`, and any bullet — annotated or not — that exceeds the
   180-visible-character budget in `STYLE.md §5.4` (a `.tradeoff`'s own
   text additionally caps at 100 characters). That budget is one
   coherent number derived from `build/bullet-length-check.html`
   actually rendering worst-case text in the page and measuring wrapped
   lines — open that file after any type-scale, margin, or density
   change to confirm the number still holds.

   **Then run the parse gate.** `STYLE.md §8.1` lists the hazards that
   silently destroy a PDF's text layer. Run
   `node build/ats-parse-test.js` against the filled documents (it takes
   file paths as arguments, and defaults to the shipped samples) before
   step 5. It fails on tables, images, absolutely-positioned content,
   CSS columns, hidden text, `tabular-nums`, CSS `content` carrying
   meaning, contact details outside `<main>`, and `&nbsp;` in candidate
   copy — use `class="nowrap"` for value/unit pairs instead. None of
   these have a visual cost; all of them cost numbers in the parse.

   **The full gate list.** Two gates read the candidate's documents and
   take paths; the rest guard the system and its docs, and all of them
   run together with `cd build && npm test`:

   | Gate | Per-candidate? |
   |------|----------------|
   | `node build/annotation-budget-test.js <files>` | **yes** — pass the filled documents |
   | `node build/ats-parse-test.js <files>` | **yes** — pass the filled documents |
   | `node build/test.js` | no — the PDF module (needs `pdf-lib`) |
   | `node build/token-sync-test.js` | no — token/literal drift |
   | `node build/annotation-typography-test.js` | no — the annotation CSS |
   | `node build/education-placement-test.js` | no — the no-Education rule |
   | `node build/page-policy-doc-test.js` | no — the one-page default |
   | `node build/parallelism-gate-doc-test.js` · `node build/synthesis-scope-gate-doc-test.js` | no — the §11.2.3 prose rules |
   | `node build/bullet-redundancy-gate-doc-test.js` | no — the one-accomplishment-one-bullet rule |

   The `build/*-check.html` fixtures are **manual** browser checks, not
   gates — see `build/MANUAL-CHECKS.md`. Nothing runs them for you.

5. **Generate the source PDF.** From the filled HTML, render to
   PDF via Puppeteer / Playwright / equivalent. Required flags:
   `printBackground: true`, `preferCSSPageSize: true`. The system
   defines CSS named pages (`letter`, `a4`), so the PDF size matches
   automatically when `data-page="a4"` is set.

   **Page-count handling — one page is the default, always.** Every
   generated résumé targets **one page**, regardless of job title or
   seniority. Never infer a multi-page target from "Senior Staff,"
   "Principal," "Director," "VP," "executive," or any similar title
   language — title alone is never a reason to plan for a second page.
   A multi-page résumé is produced **only** when the host application
   or the candidate has explicitly requested one for this application;
   absent that explicit override, one page is the only target this
   pipeline renders toward.

   Default density is what you render first, always. After that first
   render, measure the result against the one-page target:

   - **One page.** Look for genuinely distinct, source-supported
     evidence — a real bullet, project, or skill the candidate has
     that isn't on the page yet and would improve interview odds —
     and add only that if it exists. Otherwise ship the page as it
     is; a shorter honest page beats a padded one. Never add
     adjectives, restated metrics, or filler to fill space.
   - **Overflows one page, and the overflow is small** (roughly 1–9
     lines, or the excess would occupy less than ~30% of a second
     page): apply the existing measured `data-density="compact"`
     fallback **once** and re-render. This is the system's one density
     lever — see `## Density ownership` — not a tier to escalate past.
   - **Still overflows after compact, or the overflow was large to
     begin with:** cut lower-value or redundant content per
     `STYLE.md §5` — drop a `Selected Systems` entry that restates
     bullet metrics, trim the skills block, shorten a bullet — while
     retaining **every documented role** and **at least one factual
     bullet per role**. Never drop a role, and never reduce a role to
     zero evidence, to make the page count. If the content genuinely
     can't fit one page even after those cuts, that is the signal to
     ask for the explicit multi-page override above, not to keep
     cutting roles.

   A multi-page result — from an explicit override — still uses the
   compact-density fallback and the fragmentation rules in `STYLE.md
   §6.1` exactly as before; only the *default target* changed, not the
   mechanics of how a longer résumé paginates once one is requested.
   `build/multi-page-fragmentation-check.html` is a fixture demonstrating
   that override case.

6. **Post-process the PDF** if and only if `data-print="dual-pdf"`
   is the active variant. Invoke:

   ```js
   const { addOcgBackground } = require('./build/dual-mode-pdf.js');
   const rawPdf = await fs.readFile('resume.pdf');
   const dualPdf = await addOcgBackground(rawPdf);
   await fs.writeFile('resume.pdf', dualPdf);
   ```

   If you've forked the colour palette (changed `--bg` in
   `colors_and_type.css`), pass the new value through so the
   on-screen and printed-PDF backgrounds match:

   ```js
   const dualPdf = await addOcgBackground(rawPdf, { cream: '#F7F4ED' });
   ```

   If the variant is `ink-only` or unset, skip this step — the PDF
   is already in its final form. **Never run `addOcgBackground()`
   on an `ink-only` PDF** — the cream layer would cover the
   already-white page on screen, producing an incorrect dual state.

7. **Emit the final PDF.** Filename convention: `<First-Last>.pdf`,
   no suffixes (don't ship `-dual` or `-v2` artefacts to a
   recipient). The dual-mode mechanism is invisible to recipients
   by design.

## Variant selection

The system ships four variant attributes (`data-print`, `data-page`,
`data-mono`, `data-density`), all set on the root `<html>` element.
They compose freely *except* the
two `data-print="…"` values, which are mutually exclusive. Defaults
are calibrated for the system's home territory (senior engineering
at design-conscious tech companies). For other recipients, override.

**Canonical placement — root only.** All four variant attributes
(`data-print`, `data-page`, `data-mono`, `data-density`) are valid
**only on the root `<html>` element.** The CSS selectors are all
anchored with `:root`; an attribute on `<main class="page">`, on
`<body>`, or on any other ancestor is silently ignored. There is no
legacy fallback and no mixed placement — one document, one
configuration.

```html
<html lang="en" data-print="dual-pdf" data-page="a4">
  …
  <main class="page">…</main>
```

### Embedded / host-driven consumers

When this system is used inside a host application that owns the
document shell — **Infinite Canvas** is the reference consumer — the
agent's output is **exactly a bare `<main class="page">…</main>`, with
no `data-*` variant attributes on it or anywhere inside it.** The host
owns the root element and sets the variant attributes there. The host
also owns density: it renders at default density first and enables
`data-density="compact"` on the root only after it has *measured* an
overflow. Do not pre-emptively emit a variant attribute, a wrapper
`<html>`, or a `<style>` block — they will either be stripped or, if
placed on the page element, do nothing at all.

### Step 1 — Classify the recipient

Work from the named-company list first. If the company name is
not listed, fall through to the prose-style heuristics below.
If still unclassifiable, take the named fallback. **Never agonise**
— the wrong call here is recoverable; the right call here is not
worth more than 30 seconds of inference.

**Per-company decision rule:**

| Recipient profile                                                                          | Variants                                                       |
|--------------------------------------------------------------------------------------------|----------------------------------------------------------------|
| Design-conscious tech / startup (Anthropic, Stripe, Linear, Figma, Vercel, Notion, Render, Modal, Replicate, Cursor, Anduril, infra startups, design-led seed/Series-A) | `data-print="dual-pdf"` *(default)*                            |
| Quant-finance / design-conscious finance (Jane Street, Hudson River Trading at IC level)   | `data-print="dual-pdf"` — these firms read carefully; taste reads positively |
| Big-co tech with Workday-class ATS at the front (Google, Meta, Amazon, Microsoft, Apple, Salesforce, Oracle, Atlassian, Shopify, most public tech) | `data-print="ink-only"`                                        |
| Traditional enterprise / consulting (IBM, Accenture, Deloitte, Big-4, MBB-tier)            | `data-print="ink-only" data-mono`                              |
| Traditional finance back-office / banking IT (most bulge-bracket roles outside Citadel/Two Sigma's eng tracks) | `data-print="ink-only" data-mono`                              |
| Defense / government / cleared roles (exception: Anduril is design-conscious tech)         | `data-print="ink-only" data-mono`                              |
| Big-law / law-tech                                                                         | `data-print="ink-only" data-mono`                              |
| Healthcare admin / insurance tech                                                          | `data-print="ink-only" data-mono`                              |
| Academia / national labs                                                                   | Reconsider — likely wrong design system. If forced: `ink-only data-mono` |
| **Unknown / can't classify with confidence**                                               | `data-print="dual-pdf"` (named fallback)                       |

### Step 2 — If the company isn't on the list, infer from the JD

Read the job description's prose for stylistic signals. Apply
these in order; first match wins:

1. **Words that signal design-conscious tech:** "craft", "taste",
   "design-led", "pixel-perfect", "thoughtful", "opinionated",
   "product sensibility", "polish". → `data-print="dual-pdf"`
2. **Words that signal scale / process-heavy enterprise:**
   "enterprise-scale", "governance", "compliance", "stakeholders"
   used five+ times, "matrix organisation", "global".
   → `data-print="ink-only"`
3. **Words that signal conservative industry:** "regulated",
   "audit", "clearance", "FedRAMP", "SOC 2" *(as a job
   requirement, not a feature)*, "underwriting", "actuarial".
   → `data-print="ink-only" data-mono`
4. **JD prose itself is overformatted / clichéd / corporate-template:**
   the firm probably doesn't read design signals. Match the
   recipient: `data-print="ink-only"` or `ink-only data-mono`.
5. **JD prose is sparse, conversational, written by an engineer:**
   the firm probably reads design signals positively. Default to
   `data-print="dual-pdf"`.
6. **None of the above:** named fallback — `data-print="dual-pdf"`.

### Step 3 — Composable refinements

Both go on the root `<html>` element, alongside `data-print`.

- `data-page="a4"` — pair with any of the above when shipping to
  non-US recipients. Recomputes margins for A4 stock and routes
  the print to the `@page a4` rule (or `@page a4-compact` when
  compact is also set).
- `data-density="compact"` — apply *only after* a first render
  shows overflow. See §Pipeline step 5 for the operational rule.
  Do **not** apply pre-emptively — the default density is
  calibrated for readability at this fidelity.

## Density ownership

One density variant exists: `data-density="compact"`, on the root
`<html>` element, and it is a **measured-fit fallback**. The rules,
in full:

- **Default density is the default.** Render it first, every time.
  The default-density appearance is the system's calibrated look and
  must not change to make more content fit.
- **Compact is applied only after a render has measured an
  overflow** — never speculatively, never because the input looks
  long.
- **There are no other tiers.** No `ultra-compact`, no numeric
  scale, no per-section density. If compact still overflows, the
  content is too long: cut a bullet, drop a restating
  `Selected Systems` entry, trim the skills block.
- **Compact does not replace content editing.** Typographic
  compression is not a substitute for cutting weak material, and a
  content-bloated résumé at compact density is just bad material
  set smaller.
- **In host-driven consumers (Infinite Canvas), the host owns
  this.** The agent emits a bare `<main class="page">`; the app
  renders default density, measures, and only then sets
  `data-density="compact"` on the root.

### Rationales (one sentence each, in case the agent needs to explain its choice)

- **dual-pdf for design-conscious tech:** one PDF that the
  recipient can both view (warm cream + oxblood) and print (white
  + oxblood) without any action on their part. The system's
  character survives in the room where it's an asset.
- **ink-only for big-co ATS:** Workday-class pipelines convert
  PDFs to plain text for keyword indexing — the cream is discarded
  anyway. The parsed PDF circulated to the hiring panel reads as
  "doesn't understand the genre" if it looks overdesigned. White +
  oxblood is the closest the system gets to ATS-safe while
  preserving identity.
- **mono on top of ink-only for conservative industries:** in
  defense, big-law, traditional banking IT, even the oxblood
  letter form reads as taking up too much narrative space.
  `data-mono` rebinds `--accent-on` to ink — same template, no
  accent. The restraint *is* the signal.

## Content rules (the part agents most often get wrong)

The design will amplify whatever it wraps. Bad content in this
template looks worse than bad content in Calibri — the visual
confidence becomes a magnifying glass on the substance gap.

**Order matters as much as content.** Within a role, sequence the
bullets by relevance to the target job (`STYLE.md §5.3.2`) before
applying the per-bullet rules below — chronology and raw metric size
are not ordering criteria.

Hard rules for every bullet:

- **At least one specific number** (scale, latency, throughput,
  team size, revenue impact, $ saved). Numbers go in `<strong>` — this
  marks them as metrics in the markup, but they render at the same
  weight as the rest of the bullet, not bold (STYLE.md §5.4.1). This
  is the default evidence every bullet should carry.
- **A `.tradeoff` annotation is optional, not a substitute for the
  number above.** Reach for it only when the bullet reports a
  genuinely decision-defining alternative or constraint (prefixed with
  " · trade-off:", set in the bullet's own type — never italic or
  caption-sized), and only when it still fits inside the length budget
  (`STYLE.md §5.4` — at most one per bullet, the annotation text under
  100 characters, the whole bullet — same as any other — under 180).
  Don't add one just
  because a bullet has no hard metric, and don't let it turn a 1-2-line
  bullet into a paragraph — fold ordinary implementation detail into
  the main sentence instead. A bullet with neither a number nor a real
  trade-off should be rewritten or cut, not padded with an annotation.
- **No bare adjectives.** "Optimised", "improved", "led" without
  measured outcomes are wasted lines. Cut them.
- **1.0–2.0 wrapped lines per bullet.** Three-line bullets read
  as paragraphs and break the rhythm of the section.
- **3–6 bullets per role.** Fewer reads thin; more reads as a list.
- **No dash may join ideas.** See `## Dash punctuation` below. This
  is a hard gate, checked before the PDF is rendered.
- **No colon-led inventory, no overloaded sentence, no reused
  metaphor, no broken parallelism, no unearned generalization** — in
  bullets, role summaries, and
  project descriptions alike. A colon whose right-hand side is three
  or more parallel technology phrases, a sentence carrying several
  systems plus a conclusion, a figure of speech doing connective work,
  a coordinated phrase (`from X through Y`, `both X and Y`, a
  list) whose two sides don't share a grammatical form — a noun
  phrase paired with a gerund phrase, for instance — and a conclusion
  broader than the evidence under it, or resting on an undefined
  "shape"/"pattern"/"approach", are all rejected
  on the résumé for the same reasons they are in the letter
  (`STYLE.md §11.2.3`).
- **Technology verbs describe technology roles.** Do not make a web server or
  application server a means of containerization merely because it runs in a
  container. State the container/orchestration operation separately from the
  serving or application-runtime operation, and give each named technology an
  accurate governing verb.

Verbs to prefer: *designed, shipped, owned, drove, killed, replaced,
rewrote, migrated, decommissioned, halved, tripled, tenfold-d*.
Verbs to avoid: *worked on, helped, participated in, assisted with,
contributed to* — they describe presence, not authorship.

The bullet vocabulary should read like distilled system-design
interview answers: **Problem → Solution → Measurement → Trade-off.**
That four-beat structure is what the template's typography is built
to display.

## Dash punctuation (hard gate)

A dash may live **inside a word or a value**. It may never **connect
ideas**. This applies to every string the agent writes into the
template: bullets, role summaries, project descriptions, annotations,
and every sentence of the cover letter. The full rule with rationale
is `STYLE.md §5.3.1`.

**Keep** hyphenated compounds (`app-side`, `one-page`, `end-to-end`,
`11-month`), technical names that carry the hyphen (`consistent-hash`,
`us-east-2`), email addresses and URLs, and en dashes inside date or
numeric ranges (`Mar 2022 – Present`, `3–5 engineers`).

**Never emit**

- An em dash (`—`) anywhere in candidate copy: not joining clauses,
  not introducing an explanation, not trailing an afterthought, not as
  a pair of parentheses around an aside.
- An en dash (`–`) as sentence punctuation. Ranges only.
- A hyphen-minus (`-`) standing in for either of the above.

**Rewrite pattern.** Reject the left column, emit the right:

| Reject | Emit |
|---|---|
| "Led the migration — reducing p99 latency by 40%." | "Led the migration, reducing p99 latency by 40%." |
| "Improved the system — and reduced operating cost." | "Improved the system and reduced operating cost." |
| "I am interested in this role – it aligns with my experience." | "I am interested in this role because it aligns with my experience." |
| "The project succeeded - despite the initial constraints." | "The project succeeded despite the initial constraints." |

Repair kit, in order: comma, semicolon, colon before a real
explanation, conjunction (`and`, `because`, `so`, `while`),
parentheses for a true aside, two sentences. Do not swap one dash for
another. (A colon introducing one explanatory clause is still an
allowed repair; a colon introducing three or more inventoried items
is forbidden regardless — see `STYLE.md §11.2.3`.)

For *structural* label-and-value pairs (a role summary, an annotation
lead-in) the system's separator is the mid dot, not a dash:
`Storage platform · tech lead, team of 8`. The `.scope` annotation
lead-in is ` · `; the `.tradeoff` lead-in is ` · trade-off: `.

**Check before rendering** (pipeline step 4, non-negotiable):

```sh
grep -n '\xe2\x80\x94' filled.html    # em dash        → must be empty
grep -nE ' - | -$' filled.html        # spaced hyphen  → must be empty
grep -n '\xe2\x80\x93' filled.html    # en dash        → every hit is a range
```

If the first two return anything, fix the copy and re-check. Do not
render a PDF from a document that fails this gate.

## The Skills block — selection and sizing

**Budget: 3 rows, one line each, 16–20 terms** — that is the ceiling,
and it is what the shipped `resume.html` sample does (3 rows /
16 terms: Languages 5, Data & Storage 5, Infrastructure 6). A block
that grows past 3 rows starts buying page space with the weakest
content on the page; count the rows before you count anything else.

What goes in it:

- **Only nouns a recruiter can filter on** — languages, databases,
  named platforms, named infra products. These are what populate the
  structured skills field (Greenhouse) and skill tags (Ashby), both of
  which are extracted off the `Skills` section header, and both of
  which recruiters filter on directly.
- **Never concepts.** Raft, Paxos, CRDTs, consistent hashing, leader
  election, gossip, vector clocks, multi-region failover are
  *architecture decisions*. In a bullet they are evidence; in the
  skills block they read as padding a staff candidate doesn't need.
- **Never commodity tooling** (Grafana, Honeycomb, Jira, Postman) and
  never region lists — `AWS`, not `AWS (us-east, eu-west, ap-northeast)`.
- **Keep the labelled `dt`/`dd` rows.** Do not collapse to a single
  unlabelled keyword line: the category labels are part of what the
  parser's section classifier keys on, and the space saved is a
  fraction of one line.
- **Title Case the `dt`, and label the domain, not the section.**
  `Languages`, `Data & Storage`, `Infrastructure`. Nothing uppercases
  this label for you, so `technologies` prints lowercase beside them;
  leave a label that already carries an uppercase letter as written
  (`AI/ML`, `iOS`) and keep a connecting `and` lowercase. A row
  labelled `Skills`, `Technical Skills` or `Technologies` names the
  section head above it rather than a kind of skill, so it gives the
  parser no category the `Skills` header did not already give it, and
  the host validator rejects it. Name the domain the row holds.
- **Do not delete the section.** Its value is the terms that appear
  nowhere else — in the shipped sample, **12 of the 16 terms appear
  only in Skills** (Go, Postgres, Kafka, and Elasticsearch are the
  four that also appear in a bullet). A backend/data/AI candidate
  with no Skills section also reads as an omission to a recruiter
  using it as a stack check.

**Deliberate duplication is correct for the 6–8 must-have terms.**
Section extraction and full-text search are separate retrieval paths: a
technology named only mid-bullet reaches full-text search but often not
the skills tag. Naming Go in a bullet *and* in Skills is not keyword
stuffing — what is penalised now is hidden text and stuffed sections.

Where the technology already earns its place in a bullet ("built the
Kafka → Elasticsearch pipeline"), the bullet is the stronger evidence
and the Skills entry is the index. Write both. Where a technology can
only be claimed, not demonstrated — Terraform, TypeScript, a warehouse
the candidate queried — the Skills block is the *only* place it exists,
and cutting it loses the term outright.

## Do not let a project section restate the bullets

The most common space waste in generated output is not the skills block
— it is a project section that re-lists metrics already in
the Experience bullets. It is typically the largest block on the page
after Experience itself. The shipped `resume.html` sample used to ship
one; every metric it carried (1.4M QPS, p99 38 ms, 19 PB, 50K docs/sec)
also appeared in a bullet above, so it was cut outright when the sample
was recalibrated to the one-page default (`STYLE.md §6`) — the sample
now demonstrates this rule instead of being an exception to it.
`preview/component-projects.html` still shows the component on its
own, and `build/multi-page-fragmentation-check.html` shows one in
context.

A project entry earns its place only if it carries something the
bullets do not: a system the candidate built outside the roles listed,
open-source work, or an architecture whose shape needs a sentence the
role bullets have no room for. If every metric in the block already
appears above it, **cut the whole section** — it is the single largest
free space recovery available, and it costs zero searchable terms.

## A project is carried for one posting, not for every posting

Not restating the bullets is necessary and not sufficient. The second
question is whether this posting gives the entry a reason to be read at
all, and it is a different question: a project can be entirely true of
the candidate, prove something no bullet proves, and still belong on no
résumé for this job. Personal projects are not a standing section that
every résumé carries by default — carry one where the posting asks for
what it shows, and omit it where the posting does not, even though
nothing about the project changed between the two applications.

So a project earns its place by answering something the posting
actually says: it cites a job-listing quote beside its career-data
evidence, and its name and description share that quote's own
vocabulary. A project with no listing quote it can honestly cite is
telling you it answers nothing this employer asked for. Omit it — and
do not reach for a loosely related quote to keep it, which only spends
the reader's attention on work this role has no use for.

## Do not let one bullet restate another

The same failure this file already guards against in `## Do not let a
project section restate the bullets` shows up one level in: a role
whose bullets restate each other instead of restating a project. A
shipped résumé once reported one accomplishment — a full-stack
internal-tools hub — as three separate `<li>`s: one that built it, one
that containerized it for deployment, one that added a fee-tracking
feature to it. Every one of the three was individually self-contained,
individually under the 180-character budget (`STYLE.md §5.4`), and
individually grounded — so every rule already in this file passed it —
while the role carried 9 bullets for 4 real accomplishments, past the
3–6 ceiling above.

**One accomplishment, one bullet.** A bullet earns its place in a role
only by carrying something no other bullet in that role carries — a
distinct system, outcome, or judgment call — the same
carries-something-no-other-entry-carries test `## Do not let a project
section restate the bullets` applies to a project entry against the
bullet corpus, applied here bullet-to-bullet within one role. Where two
or three bullets report the same system's build, its deployment, and
one of its features, combine them into a single bullet whose trailing
clause carries the supporting mechanism, constraint, or result — not
three `<li>`s. A quick check for the pattern: a bullet whose subject is
the previous bullet's object — "Containerized **the internal-tools
hub**…" right after the bullet that built it — is almost always the
second half of one accomplishment, not a second one.

**Splitting a bullet is never the repair for a short page.** A page
that runs short calls for source-supported evidence the résumé hasn't
used yet — a different accomplishment, project, or skill — never a
second bullet about an accomplishment already on the page. The case
above measured 74.1% of the type area and split rather than reach for
unused evidence; the repair was the unused career data, not a second
and third bullet about a system the page already covered.

## Negative space — what the system does NOT do

- No icons, no skill bars, no progress dots, no photos
- No skills block over 3 rows / 20 terms, and no concepts or
  commodity tooling inside it
- No candidate location that wasn't explicitly supplied as contact
  data — never inferred from the job, employer, or school. (This is
  the contact line only. A role's own stated work location is a
  required employment fact — see step 1 and `STYLE.md §5.2`.)
- No `Selected Systems` entry whose metrics already appear in a bullet
- No bullet whose accomplishment already appears, in whole or in
  part, in another bullet in the same role
- No coloured ranges, no gradients, no rounded cards
- No emoji
- No em dash anywhere in candidate copy, and no en dash outside a
  date or numeric range (see `## Dash punctuation`)
- No two-column layouts (the date cell is right-aligned within
  the same flex row — it is not a parsed second column)
- No "summary" or "objective" paragraph at the top
- No Education section, in any form — the degree and institution
  ride in the header subtitle (`STYLE.md §5.8`), and a candidate with
  no documented degree gets a role-only subtitle, not a fallback
  layout
- No specialisation / marketing tagline under the name — the subtitle
  is role + degree + institution, or role alone
- No links to publications, talks, or media beyond a single
  optional canonical URL in the contact line

When in doubt, cut the element. The system's signal is restraint.

## When NOT to use this system

If any of these apply, this is the wrong design system — produce
something else or fall back to a plainer ATS-safe template:

- Candidate is junior or mid-level (IC1–IC3): visual confidence
  reads as overreach
- Content is generic and lacks scale numbers / trade-offs: the
  design will amplify the gap, not hide it
- Recipient is academia, government, or any industry where the
  expected format is the Harvard CV (Times, white, B&W,
  comprehensive)
- Job description explicitly requires a specific format
  (one-column ATS-only, Calibri 11pt, no colour, etc.)

For these cases, refuse the design system rather than degrade it
— the candidate is better served by a fit-to-genre template.
