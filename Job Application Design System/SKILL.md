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
| `styles.css`                  | Global entry point — re-exports the token closure.                                 |
| `colors_and_type.css`         | Design tokens — colour, typography, spacing, page geometry, all variants.          |
| `resume.css`                  | Components — page chrome, header, sections, roles, bullets, projects, skills. |
| `resume.html`                 | The résumé template + a fully-populated realistic sample. Adapt this per candidate. |
| `cover-letter.css`            | The letter surface (serif body, date / recipient / close). Load after `resume.css`. |
| `cover-letter.html`           | The paired cover-letter template + sample. Same paper, ink, and geometry.           |
| `build/dual-mode-pdf.js`      | Pure module exporting `addOcgBackground(bytes) → bytes`. UMD; loads in Node or browser. |
| `build/test.js` · `build/browser-test.html` | Self-test for the dual-mode PDF module (Node / browser). |
| `build/annotation-typography-test.js` | Typography regression: the inline `.scope` / `.tradeoff` / `.annotation-label` spans must inherit the owning bullet's type, and `.tradeoff` must not be italic (STYLE.md §5.4). Static; no browser needed. |
| `build/ats-parse-test.js`     | Parse-safety gate (STYLE.md §8.1): fails on tables, imagery in `<main>`, absolute positioning, CSS columns, hidden text, tabular figures, `&nbsp;` in copy, contact outside `<main>`, and reading-order inversions. Takes file paths; defaults to the shipped samples. |
| `build/annotation-typography-test.html` | Computed-style companion to the above — measures a rendered bullet in a real engine. |
| `build/vendor/` (removed)     | pdf-lib 1.17.1 now loads from CDN (browser) / the `pdf-lib` npm package (Node) — no longer vendored. |
| `fonts/` (removed)            | Source Serif 4, Inter, IBM Plex Mono now load from the Google Fonts CDN — no longer bundled. |
| `preview/`                    | Standalone preview cards for each design subsystem. Reference material only.       |

## The pipeline

End-to-end, given candidate data + job description:

1. **Parse candidate data.** Extract: name, contact (email and
   phone; optionally a supplied location and at most one canonical
   URL, site OR github, never both), 3–6 role entries
   with titles + companies + dates + 3–6 bullets each, optional
   "Selected Systems" / "Projects", a skills block, and the highest
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
   letter's letterhead. Per-role `.role-location` values are
   employment facts and may be used when supplied with the role.

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
   `.scope` cell for role ownership, `.tradeoff` for trade-off
   annotations on staff-level bullets, `<strong>` for scale numbers
   inside bullets.

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

   **The letter date is never typed in.** `cover-letter.html` fills it
   from the system clock at render time (month + year, plus the
   `datetime` attribute) — see `STYLE.md §11.6`. Leave that element
   and its inline script alone; if your pipeline renders without
   JavaScript, substitute the current month yourself at fill time.

   **Then run the parse gate.** `STYLE.md §8.1` lists the hazards that
   silently destroy a PDF's text layer. Run
   `node build/ats-parse-test.js` against the filled documents (it takes
   file paths as arguments, and defaults to the shipped samples) before
   step 5. It fails on tables, images, absolutely-positioned content,
   CSS columns, hidden text, `tabular-nums`, CSS `content` carrying
   meaning, contact details outside `<main>`, and `&nbsp;` in candidate
   copy — use `class="nowrap"` for value/unit pairs instead. None of
   these have a visual cost; all of them cost numbers in the parse.

5. **Generate the source PDF.** From the filled HTML, render to
   PDF via Puppeteer / Playwright / equivalent. Required flags:
   `printBackground: true`, `preferCSSPageSize: true`. The system
   defines CSS named pages (`letter`, `a4`), so the PDF size matches
   automatically when `data-page="a4"` is set.

   **Page-count handling — the compact-density algorithm.** Default
   density is what you render first, always. After that first
   render, count the pages in the produced PDF:

   - **Page count == target.** Ship as-is. Don't apply
     `data-density="compact"`.
   - **Page count > target AND overflow looks small** (~1–9 lines,
     or the final page is < 30% full): set
     `data-density="compact"` on the root `<html>` element and
     re-render once. This reclaims 6–9 lines per page and usually
     fits the content.
   - **Page count > target AND overflow is large** (final page >
     30% full, or > 9 lines): the *content* is too long. Cut
     bullets per the rules in `STYLE.md §5` before re-rendering.
     Compact density alone won't save it, and applying it to a
     content-bloated résumé just compresses bad material.

   `compact` is the system's **one** measured-fit fallback. It is
   never the default, there is no second tier, and it is not a
   substitute for editing content — see `## Density ownership`.

   Target page count is conventionally 1 for IC roles up to staff
   and 2 for principal+. Don't deviate without a reason in the JD.

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

Hard rules for every bullet:

- **At least one specific number** (scale, latency, throughput,
  team size, revenue impact, $ saved). Numbers go in `<strong>`.
- **Or one trade-off annotation** (prefixed with " ·
  trade-off:", set in the bullet's own type — never italic or
  caption-sized). At most one per bullet; staff-level differentiator.
- **No bare adjectives.** "Optimised", "improved", "led" without
  measured outcomes are wasted lines. Cut them.
- **1.0–2.0 wrapped lines per bullet.** Three-line bullets read
  as paragraphs and break the rhythm of the section.
- **3–6 bullets per role.** Fewer reads thin; more reads as a list.
- **No dash may join ideas.** See `## Dash punctuation` below. This
  is a hard gate, checked before the PDF is rendered.

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
another.

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

## Do not let "Selected Systems" restate the bullets

The most common space waste in generated output is not the skills block
— it is a `Selected Systems` section that re-lists metrics already in
the Experience bullets. It is typically the largest block on the page
after Experience itself, and in the shipped sample every metric in it
(1.4M QPS, p99 38 ms, 19 PB, cold-start 380 → 18 ms, 50K docs/sec)
also appears in a bullet above.

A project entry earns its place only if it carries something the
bullets do not: a system the candidate built outside the roles listed,
open-source work, or an architecture whose shape needs a sentence the
role bullets have no room for. If every metric in the block already
appears above it, **cut the whole section** — it is the single largest
free space recovery available, and it costs zero searchable terms.
## Negative space — what the system does NOT do

- No icons, no skill bars, no progress dots, no photos
- No skills block over 3 rows / 20 terms, and no concepts or
  commodity tooling inside it
- No candidate location that wasn't explicitly supplied as contact
  data — never inferred from the job, employer, or school
- No `Selected Systems` entry whose metrics already appear in a bullet
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
