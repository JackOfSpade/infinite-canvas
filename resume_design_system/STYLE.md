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
| Body     | **Inter**             | Brand-supplied body family (local `.woff2`, weights 400/500/600). Neutral, modern, and the industry-standard digital text face — pairs cleanly with Source Serif 4 on the name. |
| Mono     | **IBM Plex Mono**     | Inline code-like terms (`v8::SnapshotCreator`, `mmap`); reads as *terms*, not prose. Used only for `<code>`/`<kbd>`/`<samp>` and the project-metrics line. |

All three families ship locally in `fonts/`:
- `SourceSerif4-{Regular,Semibold}.ttf`
- `Inter-{Regular,Medium,SemiBold}.woff2` — **no Bold (700)**. The
  system uses SemiBold (600) for every "bold" affordance to keep
  the voice quietly confident, not loud.
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
| `--ink-2`     | `#54504A` | Secondary — dates, locations, role summary, **scope &amp; trade-off annotations**, project-metrics line. |
| `--ink-3`     | `#8C857A` | Tertiary — bullet glyphs, the most subdued metadata. |
| `--ink-4`     | `#B6AFA2` | Quaternary — separators (`·`), title-line glyphs, the `—`/`trade-off:` lead-ins. |
| `--bg-rule`   | 10% ink   | Hairline rule under section headers, link baselines. |
| `--accent`    | `#7A1F2B` | Oxblood. Used only on the candidate name.        |
| `--accent-on` | (alias)   | Indirection token. Default = `--accent`. Override to `--ink-1` for the monochrome variant. |

**Semantic aliases** for the ink scale are also exposed and are the
preferred reference in new component CSS — they self-document and
survive future renames:

| Alias         | = positional | Meaning in context                       |
|---------------|--------------|------------------------------------------|
| `--ink-body`  | `--ink-1`    | Body copy, role titles, the name         |
| `--ink-meta`  | `--ink-2`    | Dates, locations, annotations            |
| `--ink-quiet` | `--ink-3`    | Bullet glyphs, subdued metadata          |
| `--ink-fade`  | `--ink-4`    | Separators, annotation lead-in labels    |

Use the positional names when the *position* in the scale is what's
being expressed (e.g. a 50% mix between `--ink-2` and `--ink-3`).
Use the semantic names everywhere else.

**Scope &amp; trade-off annotations are deliberately at `--ink-2`,
not `--ink-3`.** The staff-level thinking on display ("why this
decision, what we gave up") needs to register on a skim, not
retreat into footnote grey. The same call holds for the
project-metrics line.

### 3.2 Accent rules

The accent colour exists. It is used in **exactly one place** by
default: the candidate's name. The reason it exists at all is that
the name is the only piece of the document that is unambiguously a
mark of identity — colouring it lightly says "this person" without
shouting "look at me".

To go fully monochrome, add `data-mono` to the `<main class="page">`
element (or to `<html>` for the whole document). The variant
selector in `colors_and_type.css` rebinds `--accent-on` to
`--ink-1`. See `preview/variant-monochrome.html`.

**Do not** introduce a second accent. **Do not** apply the accent to
section headers, role titles, or links. The artifact is meant to read
as ink on paper, not as a webpage.

### 3.3 Background

- Never pure white (`#FFFFFF`). Warm off-white only.
- Never a gradient. No texture. No image. No watermark.
- In screen preview, the *area around* the page may be a soft warm
  gradient to suggest paper; the page itself is flat `--bg`.

---

## 4. Spacing

Two scales coexist, on purpose.

### 4.1 4 pt scale — inline / intra-block spacing

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
| `--s-9` | 32pt | (reserved — historical use; section spacing now via `--vr-2`) |
| `--s-10`| 40pt | (reserved — large blocks)                     |

### 4.2 Vertical-rhythm scale — baseline-keyed block spacing

`--baseline` is computed as `calc(var(--fs-body) * var(--lh-body))`
— one line-box of body text, ~14.86 pt by default. The `--vr-*`
tokens are multiples of `--baseline` and are used wherever vertical
rhythm matters (section ↔ section, header block ↔ first section,
subsection heads).

| Token       | = baseline × | ~pt   | Used between                            |
|-------------|--------------|-------|-----------------------------------------|
| `--vr-half` | 0.5          |  7.4  | subsection-head bottom gap              |
| `--vr-1`    | 1            | 14.9  | subsection-head top gap                 |
| `--vr-1-5`  | 1.5          | 22.3  | (reserved)                              |
| `--vr-2`    | 2            | 29.7  | section ↔ section                       |

Why two scales: the 4 pt grid is right for inline gaps where rhythm
is a side effect of consistency. The baseline-keyed scale is right
for block boundaries where rhythm is the *point* — changing
`--fs-body` (e.g. via `data-density="compact"`) recomputes every
`--vr-*` token automatically, so the page stays on its grid.

The vertical rhythm uses these multiples almost everywhere. Where a
specific text-baseline alignment beats the grid, the grid loses;
visual rhythm is the rule, not arithmetic.

### 4.3 Inline separator gaps

| Token              | Value  | Used                                           |
|--------------------|--------|------------------------------------------------|
| `--sep-gap-tight`  | 0.35em | Default `.sep` margin — prose-adjacent runs    |
| `--sep-gap-loose`  | 0.5em  | `.sep.sep-loose` — mono / metric / digit runs  |

Never override `.sep` margins per context. If a context needs more
breathing room (typically because digits are involved), add the
`sep-loose` modifier to the span. Two values cover every usage.

### 4.4 Page geometry

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

- Bullet glyph is **always `•` (U+2022)**, applied via the
  `.highlights li::before` pseudo-element — not typed into the
  bullet text. The CSS hardcodes this; do not override it. The
  glyphs `·` (separator inside the contact line and metrics),
  `–` (en dash, date ranges), `—` (em dash, prose), and `→` (state
  change inside a bullet's prose, e.g. `380 ms → 18 ms`) are the
  complete typographic vocabulary. **Never** an arrow as a bullet
  marker. **Never** an emoji.
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
  `--ink-meta`.
- `<span class="tradeoff">…</span>` — decision / alternative /
  constraint statement. Renders prefixed with " · trade-off: " in
  italic `--ink-meta`.

Both annotations sit at `--ink-meta`, the same level as dates and
locations — deliberately. The scope number and the trade-off are the
staff-level thinking on display, so they need to register on a skim,
not retreat into footnote grey. They remain inline (never on their
own line) so the bullet and its reasoning stay visually coupled.

**Label markup.** The prefix label is a real inline span, not
CSS-injected content. The full markup is:

```html
<span class="scope">
  <span class="annotation-label"> — </span>8 engineers, 11-month project…
</span>
<span class="tradeoff">
  <span class="annotation-label"> · trade-off: </span>CRDT vs. Raft…
</span>
```

This keeps the label text in the document layer where it can be
localised, omitted, or linted, and lets copy-paste round-trip
correctly. (CSS `content` is dropped on copy in many engines.)

Use **at most one** of these per bullet. They are noise above one per
bullet.

### 5.5 Meta-row utility

The "content left, right-aligned meta right" grid pattern — a single
`grid-template-columns: 1fr auto` row — is exposed as a
utility class, `.meta-row`. The role header, role-meta line, and
edu line all compose with it:

```html
<div class="role-header meta-row">…</div>
<div class="role-meta meta-row">…</div>
<div class="edu-line meta-row">…</div>
```

Add `.meta-row` to any future block that needs the same alignment
behaviour. Element-specific classes layer typography / spacing /
break rules on top; the grid itself is defined once.

The `.project` block intentionally does **not** use `.meta-row`:
project metrics are a mono-set numeric run that wraps poorly inside
a 1.45 in right column. They stack below the description instead.

### 5.6 Subsection heads

For groupings *inside* a section — "Open Source" under Experience,
"Talks" under Education — use the subsection-head pattern:

```html
<div class="subsection-head">
  <h3>Open Source</h3>
  <span class="rule" aria-hidden="true"></span>
</div>
```

It renders as italic 9.5 pt at `--ink-meta` with the same hairline
rule. Quieter than `.section-head`, on purpose: it groups, it
doesn't divide.

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
| `basics.profiles[].url`                  | `.contact a[itemprop=sameAs]` (visible label = host + path, e.g. `github.com/acastellanos`; the `.network` field is metadata only and not rendered) |
| `basics.url`                             | `.contact a[itemprop=url]`               |
| `work[].position`                        | `.role-title-line .title`                |
| `work[].name`                            | `.role-title-line .company`              |
| `work[].startDate`, `.endDate`           | `.role-dates time`                       |
| `work[].location`                        | `.role-location`                         |
| `work[].x_summary`                       | `.role-summary`                          |
| `work[].highlights[i].text`              | `.highlights li` (text node)             |
| `work[].highlights[i].x_scope`           | `.highlights li > .scope`                |
| `work[].highlights[i].x_tradeoff`        | `.highlights li > .tradeoff`             |
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

## 10. Variants

The system ships five opt-in variants. All apply via data attribute
on the `<main class="page">` element (or on `<html>` for global
scope). All are defined in `colors_and_type.css` under "Variants".
Variants compose cleanly — `data-page="a4" data-mono
data-density="compact" data-print="dual-pdf"` is a valid combination.

**The two `data-print="…"` values are mutually exclusive.** Pick one:
`ink-only` for a single-state white-paper PDF, or `dual-pdf` for a
two-state PDF that shows cream on screen and prints white. `dual-pdf`
is the default in `resume.html`.

### 10.1 A4 paper

```html
<html data-page="a4">
```

Or scoped to a single page element:

```html
<main class="page" data-page="a4">…
```

Recomputes `--page-w`, `--page-h`, and the margin tokens so the
measure stays in editorial range on A4 stock (210 × 297 mm,
~16 mm sides, ~18 mm head/foot). The physical paper size is
selected by CSS named pages declared in `resume.html`:

```css
@page letter { size: Letter; margin: 0; }
@page a4     { size: A4;     margin: 0; }
.page                       { page: letter; }
.page[data-page="a4"]       { page: a4;     }
```

Chromium 85+ honours `page: <name>` on an element + a matching
`@page <name>` rule, so the data attribute fully controls paper
size with no top-level override. Engines without named-page
support fall through to the default `@page` block (Letter).

### 10.2 Monochrome (no oxblood accent)

```html
<main class="page" data-mono>…
```

Rebinds `--accent-on` to `--ink-1`. The candidate name renders in
the same deep ink as the body text. Useful for B&W laser pipelines,
strict-formatting clients, or recipients who explicitly request no
colour.

### 10.3 Print: ink-only

```html
<main class="page" data-print="ink-only">…
```

Flips the warm ground (`--bg`) to pure white **only when printing**.
The screen preview is unaffected — the editorial warm cream still
shows in the browser; only the printed paper / exported PDF flips.

Use this when the recipient or pipeline expects white stock
(traditional ATS conversion to B&W, conservative legal / financial
orgs, recruiters who explicitly request "no background colour").

Coloured text is **not** affected. `print-color-adjust: exact` keeps
any explicitly-coloured ink rendering at its true value, so the
oxblood `--accent-on` on the candidate name still prints in colour
on the white field. Hairline rules (`--bg-rule`) are nudged from
10% to 16% ink in this variant so they survive on white — the rule
is a translucent ink overlay, and over warm cream its perceived
contrast is slightly higher than over white, so the alpha bump
compensates without changing the rule's visual weight.

Compose with `data-mono` for the full "ink on white, no accent"
look — equivalent to a traditional B&W résumé without rewriting
any content. Compose with `data-page="a4"` or `data-density="compact"`
as needed.

### 10.4 Print: dual-pdf (default for PDF generation)

```html
<main class="page" data-print="dual-pdf">…
```

The canonical configuration for PDF generation from this design
system, and the default in `resume.html`. Produces a single PDF that
shows the warm cream editorial design on screen and prints on clean
white paper, with the oxblood candidate name preserved in both
states. No setting change required from the recipient — the dual
behaviour is encoded in the PDF itself, not in the viewer.

**How it works.** The variant strips the print-render background
to `transparent`, so a headless-Chrome "print to PDF" produces a
file with no baked-in background fill in the page content stream.
That file is then post-processed by `build/dual-mode-pdf.js` (a
pure UMD module included with this design system) which adds a
warm-cream rectangle inside a view-only Optional Content Group
(PDF spec §8.11, “Optional Content”). The OCG carries the load-
bearing flags:

```
<< /Type /OCG
   /Name (Editorial cream background)
   /Usage << /Print << /PrintState /OFF >>
             /View  << /ViewState  /ON  >> >> >>
```

Compliant PDF viewers (Adobe Reader, Chrome / Edge PDFium, macOS
Preview, Firefox PDF.js, most ATS-embedded previewers) honour these
flags: the cream renders when viewing, the print pipeline excludes
it. Non-compliant viewers degrade to one of the two valid states
(either always-cream or always-white) — never to a broken state.
The reference implementation is Adobe Reader; verify there if
uncertain.

Coloured text in the page body — the oxblood name today, any future
accents — sits in the main content stream, not in the OCG. It
survives in both states. Colour printers render it in oxblood; B&W
printers render it as a dark grey, exactly like coloured text in
any ordinary PDF.

**Agent invocation.** The full pipeline (parse → classify → fill →
render → post-process → emit) is documented in `SKILL.md §The
pipeline`. Short form for the post-process step:

```js
const { addOcgBackground } = require('./build/dual-mode-pdf.js');
const dual = await addOcgBackground(rawPdfBytes);
```

The module is UMD — same file works in Node (`require`) and browser
/ Puppeteer contexts (script tag → `window.DualModePdf`). pdf-lib
is vendored at `build/vendor/pdf-lib.min.js`; no network dependency
at build time. Pass `{ cream: '#XXXXXX' }` if you've forked `--bg`.

The transform is idempotent-guarded — calling it twice on the same
PDF throws rather than stacking two cream layers; regenerate from
source instead. The guard matches on the OCG's layer name
(`"Editorial cream background"`), so input PDFs carrying unrelated
OCGs (watermarks, accessibility layers) won't trigger false
rejections. The module also asserts no page rotation and CropBox
equal to MediaBox — misaligned input fails loudly instead of
producing a visually broken PDF.

**Hairline rule alpha.** `--bg-rule` is bumped to 16% ink (from the
default 10%) for the same reason as `ink-only`: the rules must
remain visible when the cream OCG is hidden during print. On the
cream view, this makes the rule appear very slightly heavier than
the default — an acceptable trade for printability across the
dual-mode contract. Do not lower it for visual nicety; printability
is the load-bearing constraint.

**Choosing between dual-pdf and ink-only.** The agent's per-company
decision rule lives in `SKILL.md §Variant selection`. Both are
valid shipping configurations; `dual-pdf` is the default because it
covers both screen and print rooms in a single artifact, but for
big-co ATS pipelines and conservative industries `ink-only` is the
correct call. Never run `addOcgBackground()` on an ink-only PDF —
there's no transparent background for the cream layer to sit
behind, and the result would be a cream rectangle covering the
text on screen.

Pairs cleanly with `data-page="a4"`, `data-mono`, and
`data-density="compact"`. **Does not compose with `data-print="ink-only"`**
— the two `data-print` values are mutually exclusive.

### 10.5 Compact density

```html
<main class="page" data-density="compact">…
```

The single lever for "this is 1.1 pages and I want 1.0". Body type
drops 10.25 → 9.75 pt; leading 1.45 → 1.35; block-spacing tokens
(`--s-6` / `--s-8` / `--s-9`) drop ~25%; page head/foot margins
shrink 0.72 → 0.6 in. Roughly 6–9 lines of body reclaim per page.

Deliberately untouched: `--fs-display` (the name), `--col-meta-w`
(date strings keep the same metrics), `--rule-weight`, accent,
families. Visual identity unchanged — just tighter.

If compact still overflows, the content is the problem; trim a
bullet. There is no `data-density="ultra-compact"`.

### 10.6 Running footer

Not a variant per se, but documented here: pages 2+ render a
mono page indicator (`2 / 3`) in `--ink-quiet` at the bottom-right
of the page via CSS `@page` margin boxes. Page 1 is suppressed via
`@page <named>:first` so a one-page resume never shows a counter.
Works for both `letter` and `a4` named pages.

If the rendering pipeline strips `@page` margin boxes (some legacy
print engines), the resume still prints — just without the page
indicator. No content depends on it.

---

## 11. What this template is *not*

- Not a one-pager. Not a creative CV. Not a portfolio site.
- Not driven by colour, illustration, or graphic devices.
- Not optimised for screen reading at desktop sizes — it is optimised
  for an 8.5×11 PDF that a recruiter scrolls through.
- Not a place to express personality through layout. Personality
  lives in the bullets.

When in doubt: do less, and do it more carefully.
