# STYLE.md — Editorial Resume Design System

This file documents **every design decision** in the resume template.
Future AI edits should read this end-to-end before touching `resume.html`
or `colors_and_type.css`. The goal: consistent output across many
candidates rendered from JSON, without re-litigating choices.

The voice of this template is **editorial-modernist, developer-literate,
quietly confident**. Stripe Press book interiors, Pentagram partner CVs,
the body of staffeng.com and lethain.com — that lineage. The typography
and information density are the design. There are no icons, no skill
bars, no progress dots, no photos, no color blocks, no shading.

---

## 1. Audience &amp; intent — non-negotiables

The artifact has two jobs at once:

1. **Parse cleanly.** Vector-text PDF, semantic markup, contact info in
   body text (not document headers/footers), standard section headers,
   single-column primary flow, standard bullet glyphs, normalised date
   format `Month YYYY`. Anything that breaks parsing is wrong, no matter
   how good it looks.
2. **Signal high in 6–10 seconds.** Scale numbers (QPS, p99, $),
   ownership scope (team size, system), architectural decisions and
   trade-offs, specifics over adjectives.

This template is **not** optimised to defeat ATS keyword filters — the
target ATS systems (Greenhouse, Ashby) don't auto-reject on content. It
**is** optimised for clean parsing + strong human signal. If you
encounter advice like "use a single-column 11pt Arial resume for ATS",
ignore it: it is solving a different problem.

---

## 2. Typography

### 2.1 Family pairing

| Role     | Family                | Reason                                              |
|----------|-----------------------|-----------------------------------------------------|
| Display  | **Source Serif 4**    | Editorial gravitas; one moment of warmth (the name).|
| Body     | **Inter**             | Brand-supplied body family (local `.woff2`, weights 400/500/600/700). Neutral, modern, and the industry-standard digital text face — pairs cleanly with Source Serif 4 on the name. |
| Mono     | **IBM Plex Mono**     | Technologies and inline code-like terms; reads as *terms*, not prose. |

All three families ship locally in `fonts/`:
- `SourceSerif4-{Regular,Semibold}.ttf`
- `Inter-{Regular,Medium,SemiBold,Bold}.woff2`
- `IBMPlexMono-{Regular,Medium}.ttf`

Declared via `@font-face` at the top of `colors_and_type.css`. **The
system has zero network dependencies at render time** — copy the
folder to any container or serverless environment and it renders
identically. All three families embed in PDFs produced by
Chrome/Chromium's print engine; the candidate-text-extraction
round-trip (Ctrl+A → paste-into-text) has been verified.

A **single-family fallback** is `IBM Plex Serif + Sans + Mono`. Switch
by changing `--ff-display` to `"IBM Plex Serif"`. Use this when the
output context restricts font availability.

### 2.2 Type scale (pt — units are intentional)

| Token        | Size      | Weight | Line-height | Tracking | Used on              |
|--------------|-----------|--------|-------------|----------|----------------------|
| `--fs-display` | 28pt    | 600    | 1.05        | -0.012em | candidate name       |
| `--fs-h1`      | 18pt    | 600    | 1.20        | -0.005em | (reserved — document title) |
| `--fs-h2`      |  9pt    | 500    | 1.20        | 0.14em uppercase | section headers (Experience, Skills…) |
| `--fs-h3`      | 11pt    | 600    | 1.35        | -0.005em | role title, company, project name |
| `--fs-body`    | 10.25pt | 400    | 1.45        |  0       | bullets, paragraphs, tagline tail |
| `--fs-small`   | 9.5pt   | 400    | 1.35        |  0       | dates, locations, role meta |
| `--fs-caption` | 8.75pt  | 400    | 1.35        | -0.005em | scope chip, trade-off note |
| `--fs-mono`    | 9pt     | 400    | 1.35        | -0.005em | technologies, project metrics |

The body sits at **10.25pt**, deliberately between the 10pt many
templates use (cramped) and 11pt (sparse for staff+). At 0.78in side
margins this gives 70–75 characters per line — Butterick's editorial
sweet spot.

### 2.3 Heading usage rules

- `h1` is unused in the published template. Reserved for "document
  title" if a future variant adds one.
- `h2` is **always** uppercase, tracked +0.14em, and paired with a
  hairline rule that fills the remainder of the line. Never bold.
  Never coloured. Never larger than 9pt. The visual quietness is the
  point.
- `h3` is **always** the role-title line and the project-name line.
  Bold (600). Never coloured.
- Section name text is fixed and conventional: "Experience" /
  "Work Experience", "Selected Systems" or "Projects", "Skills",
  "Education". **Never** "My Journey", "Adventures", or similar.

### 2.4 Numerals

Tabular numerals are enabled globally via
`font-feature-settings: "tnum"`. Date columns and metric lines align
across roles. Do not override this anywhere; if you need proportional
numerals in body prose, scope the override to that span.

---

## 3. Colour

### 3.1 Tokens

| Token         | Hex       | Role                                             |
|---------------|-----------|--------------------------------------------------|
| `--bg`        | `#F7F4ED` | Warm off-white ground. ~4% warm tint, not paper. |
| `--ink-1`     | `#1A1815` | Primary text. Deep warm near-black, never `#000`.|
| `--ink-2`     | `#54504A` | Secondary — dates, locations, role summary, scope &amp; trade-off annotations. |
| `--ink-3`     | `#8C857A` | Tertiary — captions and the most subdued metadata.    |
| `--ink-4`     | `#B6AFA2` | Quaternary — separators, disabled.                |
| `--bg-rule`   | 10% ink   | Hairline rule under section headers.             |
| `--accent`    | `#7A1F2B` | Oxblood. Used only on the candidate name.        |

### 3.2 Accent rules

The accent colour exists. It is used in **exactly one place** by
default: the candidate's name. The reason it exists at all is that
the name is the only piece of the document that is unambiguously a
mark of identity — colouring it lightly says "this person" without
shouting "look at me".

To go fully monochrome, set `--accent-on: var(--ink-1)` at the
`:root` or `.page` level.

**Do not** introduce a second accent. **Do not** apply the accent to
section headers, role titles, or links. The artifact is meant to read
as ink on paper, not as a webpage.

### 3.3 Background

- Never pure white (`#FFFFFF`). Warm off-white only.
- Never a gradient. No texture. No image. No watermark.
- In screen preview, the *area around* the page may be a soft warm
  gradient to suggest paper; the page itself is flat `--bg`.

---

## 4. Spacing — 4pt baseline grid

| Token | Value | Used between                                  |
|-------|-------|-----------------------------------------------|
| `--s-1` |  2pt | nudges; metric line ↔ project name           |
| `--s-2` |  4pt | name ↔ tagline                                |
| `--s-3` |  6pt | bullet ↔ bullet                               |
| `--s-4` |  8pt | role-meta ↔ first bullet                      |
| `--s-5` | 12pt | tagline ↔ contact line; project ↔ project     |
| `--s-6` | 16pt | section header ↔ section body                 |
| `--s-7` | 20pt | (reserved)                                    |
| `--s-8` | 24pt | role ↔ role within a section                  |
| `--s-9` | 32pt | section ↔ section; header block ↔ first section |
| `--s-10`| 40pt | (reserved — large blocks)                     |

The vertical rhythm uses multiples of 4pt almost everywhere. Where a
specific text-baseline alignment beats the grid, the grid loses;
visual rhythm is the rule, not 4pt arithmetic.

### 4.1 Page geometry

- Page: US Letter, 8.5 × 11 in.
- Margins: 0.72 in top/bottom, 0.78 in sides.
- Right-aligned date/location column: 1.45 in, with a 0.32 in gap from
  the primary text column. **This is visual right-alignment via
  flex/grid, not a true second column** — Workday and similar parsers
  read the bullet text as a single unbroken column.

---

## 5. Layout rules

### 5.1 Single-column primary flow

The bullets, summaries, and skills lists all flow in **one column** at
full content width. The date/location "column" on the right is a
right-aligned cell in the same grid row as the role title — it shares
a baseline with the role title and does not occupy its own column in
reading order.

Why: Workday-class parsers read the page in source order and assume a
single text flow. A real second column produces interleaved bullets
when the resume is parsed back into the database.

### 5.2 Role block anatomy

```
┌─────────────────────────────────────────────────────────┐
│  Title · Company                            Mar 2022 – Present │  ← role-header
│  Storage platform — tech lead, team of 8…    Brooklyn, NY      │  ← role-meta
│                                                                │
│  • Bullet copy that wraps to one and a half lines and          │
│    survives at body size without crowding…                     │
│  • …                                                           │
└─────────────────────────────────────────────────────────┘
```

Every role must include: title, company, dates. The summary line and
location are optional but recommended.

### 5.3 Bullet conventions

- Bullet glyph is always `•` (U+2022). Acceptable alternates: `–` (en
  dash), `*`. Never `→`, never an emoji.
- Aim for 3–6 bullets per role. Fewer than 3 looks thin; more than 6
  reads as a list, not a story.
- Each bullet should ideally contain at least one specific
  number (QPS, p99, team size, $ volume, percentage change) **or** a
  trade-off annotation. Adjectives without numbers are wasted lines.
- Acceptable bullet length: 1.0 – 2.0 wrapped lines. Avoid the
  3-line bullet — it reads as a paragraph.

### 5.4 Scope &amp; trade-off annotations

Two inline annotations exist:

- `<span class="scope">…</span>` — secondary scope metric ("8
  engineers, 11-month project"). Renders prefixed with " — " in
  `--ink-2`.
- `<span class="tradeoff">…</span>` — decision / alternative /
  constraint statement. Renders prefixed with " · trade-off: " in
  italic `--ink-2`.

Both annotations sit at `--ink-2`, the same level as dates and
locations — deliberately. The scope number and the trade-off are the
staff-level thinking on display, so they need to register on a skim,
not retreat into footnote grey. They remain inline (never on their
own line) so the bullet and its reasoning stay visually coupled.

Use **at most one** of these per bullet. They are noise above one per
bullet.

### 5.5 AI-assisted bullets

The AI-assisted bullet gets `data-ai-assisted="true"` on the `<li>`
and **no visual treatment**. The brief is explicit: treated like any
other bullet, distinguishable only via markup, so the renderer can
surface or hide it from the JSON.

---

## 6. Density rules

| Length goal | What "fits" looks like                              |
|-------------|-----------------------------------------------------|
| 1.4 pages   | 3 roles + Selected Systems + Skills + Education; page 2 ends ~40% down. The template **must** look intentional here. |
| 2.0 pages   | Same blocks with denser bullets; page 2 ends near the bottom margin. Also intentional. |

The template **does not** compress content to fit one page. Staff+
candidates have content. Trying to squeeze it loses signal.

### 6.1 Page-break behaviour

CSS Paged Media rules (`break-*`, `widows`, `orphans`) are set so
that:
- A section header never sits orphaned at the bottom of a page.
- A role's title line never appears without at least one of its
  bullets following.
- A single bullet's lines never split across pages.
- A project block never splits.

When the natural break falls badly, the fix is *content* (tighten a
bullet, reorder a role's highlights), not CSS hacks.

---

## 7. Iconography &amp; imagery

There is none. The template does not import an icon font, does not
ship SVG icons, and does not use Unicode glyphs as icons. Bullet
points, section dividers, separators (`·`), and en/em dashes are the
entire visual vocabulary.

If a future variant needs a single mark — e.g. a small monogram —
it must be ink, embedded as text, and placed in body flow.

---

## 8. Accessibility &amp; PDF output

- Render via Chrome/Chromium "Save as PDF" or `puppeteer` with
  `tagged-pdf` enabled.
- Confirm: `Ctrl+A` → copy → paste into plain text round-trips all
  content in reading order. Test after every major change.
- The header (name / tagline / contact) lives inside `<main>`, not
  the page's chrome — parsers that drop chrome will still see contact info.
- Semantic landmarks: `<main>`, `<header>`, `<section aria-labelledby>`,
  `<article>`, `<time datetime>`. Roles are `EmployeeRole`
  microdata; the person is `Person` microdata.
- Where the rendering engine supports it, emit PDF/UA-1 with tagged
  content for EU EAA compliance.

---

## 9. JSON Resume schema mapping

The HTML structure is a 1:1 mirror of JSON Resume v1.0.0 with the
following namespaced custom fields. All custom fields use the `x_`
prefix per JSON Resume convention.

| JSON path                                | HTML target                              |
|------------------------------------------|------------------------------------------|
| `basics.name`                            | `.name`                                  |
| `basics.label`                           | `.tagline`                               |
| `basics.location.{city,region}`          | `.contact > [itemprop=address]`          |
| `basics.email`                           | `.contact a[itemprop=email]`             |
| `basics.profiles[].url`                  | `.contact a[itemprop=sameAs]`            |
| `basics.url`                             | `.contact a[itemprop=url]`               |
| `work[].position`                        | `.role-title-line .title`                |
| `work[].name`                            | `.role-title-line .company`              |
| `work[].startDate`, `.endDate`           | `.role-dates time`                       |
| `work[].location`                        | `.role-location`                         |
| `work[].x_summary`                       | `.role-summary`                          |
| `work[].highlights[i].text`              | `.highlights li` (text node)             |
| `work[].highlights[i].x_scope`           | `.highlights li > .scope`                |
| `work[].highlights[i].x_tradeoff`        | `.highlights li > .tradeoff`             |
| `work[].highlights[i].x_ai_assisted`     | `.highlights li[data-ai-assisted="true"]`|
| `projects[].name`                        | `.project-name`                          |
| `projects[].description`                 | `.project-desc`                          |
| `projects[].x_metrics[]`                 | `.project-metrics` (joined with ` · `)   |
| `skills[].name`                          | `.skills dt`                             |
| `skills[].keywords[]`                    | `.skills dd` (joined with ` · `)         |
| `education[].institution`                | `.edu-school`                            |
| `education[].{studyType, area}`          | `.edu-degree`                            |
| `education[].endDate`, `.location`       | `.edu-meta`                              |

Date normalisation: incoming `YYYY-MM` → rendered "Mon YYYY"; incoming
`YYYY` → rendered "YYYY"; null `endDate` → "Present".

---

## 10. What this template is *not*

- Not a one-pager. Not a creative CV. Not a portfolio site.
- Not driven by colour, illustration, or graphic devices.
- Not optimised for screen reading at desktop sizes — it is optimised
  for an 8.5×11 PDF that a recruiter scrolls through.
- Not a place to express personality through layout. Personality
  lives in the bullets.

When in doubt: do less, and do it more carefully.
