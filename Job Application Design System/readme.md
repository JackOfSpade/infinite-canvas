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

## Sources & provenance

This system was designed from a written brief, not from an existing
codebase or brand. There are no Figma files, no GitHub repos, no
attached design assets. The references named in the brief are
**spiritual references**, not licensed source material:

- Stripe Press book interiors (Stripe — printed books)
- staffeng.com and lethain.com (Will Larson — public blogs)
- Pentagram partner CVs (public examples online)
- modern-cv on Typst Universe (open template — for typographic
  reference only)
- Matthew Butterick, *Practical Typography* (practicaltypography.com)

All three families load from the **Google Fonts CDN** (CSS2 API),
pinned to the exact weights the system uses:

- `Source Serif 4` — 400, 600
- `Inter` — 400, 500, 600 *(no Bold by design)*
- `IBM Plex Mono` — 400, 500

Loaded via a single `@import` at the top of `colors_and_type.css`. **No
longer self-contained** — typography has a render-time dependency on the
Google Fonts CDN; ensure it's reachable from the render environment, or
re-vendor the families locally for an air-gapped build. All three embed
cleanly in Chrome-rendered PDFs and match the documented aesthetic. Swap
families
by editing the `--ff-*` variables in `colors_and_type.css`; the system
is family-agnostic.

---

## Index of files

| Path                              | What it is                                                |
|-----------------------------------|-----------------------------------------------------------|
| `readme.md`                       | This file — philosophy, content rules, caveats.           |
| `STYLE.md`                        | Every design decision, fully documented. **Read first.**  |
| `SKILL.md`                        | Agent prompt — pipeline + per-company variant selection.  |
| `styles.css`                      | Global entry point — re-exports the token closure.        |
| `colors_and_type.css`             | Design tokens — color, typography, spacing, page geom, variants. |
| `resume.css`                      | Components — page chrome, header, sections, roles, bullets, projects, skills, education. |
| `resume.html`                     | The résumé template + a fully-populated sample (open this). |
| `cover-letter.css`                | The letter surface — serif body, date / recipient / close. Load after `resume.css`. |
| `cover-letter.html`               | The paired cover-letter template + sample.                |
| `build/dual-mode-pdf.js`          | Pure module exporting `addOcgBackground(bytes) → bytes`. UMD; loads in Node or browser. |
| `build/vendor/`                   | *(removed — pdf-lib is now loaded from CDN in the browser and the `pdf-lib` npm package in Node).* |
| `fonts/` (removed)                | Families now load from the Google Fonts CDN — no longer bundled. |
| `preview/`                        | Design-system reference cards (type, color, spacing, components, variants, anti-patterns). Not used at generation time. |

The system covers exactly two surfaces — the printable résumé and
its paired cover letter (`STYLE.md §11`). No app UIs, no marketing,
no decks. Adding any of those is a *separate* design system; the
typographic restraint here doesn't generalise trivially.

---

## Content fundamentals

The voice of the artifact is **first-person implicit** — bullets
elide the subject ("Designed the sharding strategy…", not
"I designed the sharding strategy…"). This is universal résumé
convention and parses cleanly; switching to "I" or "you" breaks
both.

### Casing & punctuation

- Section names are conventional and Title Cased: **Experience**,
  **Selected Systems**, **Skills**, **Education**. Never
  capitalised "EXPERIENCE" in the source — the small-caps look is
  applied via CSS `text-transform: uppercase`.
- Sentence case in bullets. Capitalise proper nouns, products,
  protocols, services (Kafka, Postgres, gRPC, V8).
- Oxford comma. Em-dash for ranges in prose (`380 ms → 18 ms`),
  en-dash for date ranges (`Mar 2022 – Present`).
- Numerals: digits for everything quantitative. **Always** include
  the unit (`38 ms`, not `38`). Figures are proportional, not tabular —
  tabular figures (`tnum`) break PDF text extraction, so they are
  disabled system-wide (see STYLE.md §2.4); column alignment comes from
  the grid, not the digits.
- Tech terms are inline `<code>` only when the term is something
  you'd type, not when it's a product name. `kubectl apply` → code;
  Kubernetes → not code.

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
3. **The trade-off.** What you gave up to get the win.
4. **The scope of ownership.** Lead, owner, IC, mentor.

### What to leave out

- The candidate's **location, unless it was explicitly supplied as
  contact data.** Never infer a city from the job posting, the
  employer's HQ, a prior office, a school, an area code, or a
  timezone — omit the field instead (`STYLE.md §9.1`).
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

---

## Visual foundations — at a glance

A one-paragraph orientation. Full rules in `STYLE.md`.

The page reads as **ink on warm paper** — flat `#F7F4ED` ground,
deep warm near-black body, **one** restrained accent (oxblood
`#7A1F2B`) used only on the candidate name. Three families:
**Source Serif 4** for the name only, **Inter** for everything
else, **IBM Plex Mono** for inline `<code>` and the project-metrics
line. Body at **10.25 pt** / 1.45 / ~70–75 chars per line. Section
headers are 9 pt uppercase tracked +0.14 em with a hairline rule
filling the line. 4 pt spacing grid. **No icons, no skill bars, no
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

## PDF generation — the agent pipeline

The default in `resume.html` is `data-print="dual-pdf"`. The full
pipeline (parse data → classify recipient → fill template → render
PDF → post-process → emit) is documented in **`SKILL.md §The
pipeline`** — that's the canonical reference. Pipeline contract in
one paragraph:

Render the filled HTML to PDF with headless Chrome
(`printBackground: true`, `preferCSSPageSize: true`). If the active
variant is `dual-pdf`, invoke `addOcgBackground(rawPdfBytes)` from
`build/dual-mode-pdf.js` to add the view-only OCG cream layer (PDF
spec §8.11). If the variant is `ink-only` (or any other), skip the
post-process step — the PDF is already in final form. Emit the
result as `<First-Last>.pdf`; the dual-mode mechanism is invisible
to recipients by design.

The build module is UMD — same file works in Node (`require`) and
browser/Puppeteer contexts (script tag → `window.DualModePdf`).
pdf-lib 1.17.1 is loaded from CDN in the browser
(`https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js`)
and from the `pdf-lib` npm package in Node (`npm i pdf-lib@1.17.1`).
Self-test: `node build/test.js` from the
project root round-trips a synthetic PDF through the module and
asserts on the OCG structure. The same assertions run through the
browser UMD path (`window.DualModePdf`) by opening
`build/browser-test.html` in any browser — coverage for the
browser/Puppeteer access path the Node test can't reach.

The agent's per-company decision rule for which variant to apply
lives in **`SKILL.md §Variant selection`**, including a
prose-style inference fallback for unlisted companies and an
explicit named-fallback for unclassifiable ones.

Pages 2+ also print a mono page indicator (`2 / 3`) at the
bottom-right via CSS `@page` margin boxes. Page 1 is suppressed so
a one-pager never shows a counter. See `STYLE.md §10.6`.

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
