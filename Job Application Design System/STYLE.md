# STYLE.md — Job Application Design System

This file documents **every design decision** in the system — the
résumé surface and its paired cover letter (§11). Future AI edits
should read this end-to-end before touching `resume.html`,
`cover-letter.html`, or `colors_and_type.css`. The goal: consistent
output across many candidates rendered from JSON, without
re-litigating choices.

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
| Body     | **Inter**             | Brand-supplied body family (Google Fonts CDN, weights 400/500/600). Neutral, modern, and the industry-standard digital text face — pairs cleanly with Source Serif 4 on the name. |
| Mono     | **IBM Plex Mono**     | Inline code-like terms (`v8::SnapshotCreator`, `mmap`); reads as *terms*, not prose. Used only for `<code>`/`<kbd>`/`<samp>` and the project-metrics line. |

All three families load from the **Google Fonts CDN** (CSS2 API),
pinned to the exact weights the system uses:

- `Source Serif 4` — 400, 600
- `Inter` — 400, 500, 600 — **no Bold (700)**. The
  system uses SemiBold (600) for every "bold" affordance to keep
  the voice quietly confident, not loud.
- `IBM Plex Mono` — 400, 500

Loaded via a single `@import` at the top of `colors_and_type.css`.
**Typography now has a render-time network dependency on the Google
Fonts CDN** — ensure the CDN is reachable from the render environment
(headless Chrome / serverless), or re-vendor the families locally if
you need an air-gapped build. All three families embed in PDFs produced by
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
| `--fs-body`    | 10.25pt | 400    | 1.45        |  0       | bullets, paragraphs |
| `--fs-small`   | 9.5pt   | 400    | 1.35        |  0       | dates, locations, role meta |
| `--fs-caption` | 8.75pt  | 400    | 1.35        | -0.005em | block-level captions (reserved) — **never** the inline `.scope` / `.tradeoff` spans |
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
  "Work Experience", "Selected Systems" or "Projects", "Skills".
  **Never** "My Journey", "Adventures", or similar. There is **no
  Education section** — the degree lives in the header subtitle
  (§5.8).

### 2.4 Numerals

Numerals are **proportional (the font default), never tabular.** Do
**not** enable `tnum` / `font-variant-numeric: tabular-nums` anywhere —
not globally, not on the date column, not on metrics.

This is a parse-safety rule, not an aesthetic one. Inter's (and Source
Serif 4's) tabular figures are GSUB-substituted glyphs with no `cmap`
entry. When Chrome prints to PDF and subsets the font, it builds the
`ToUnicode` map by reverse-lookup through the `cmap`, fails to find the
tabular digits, and assigns them **Private-Use-Area codepoints**. The
numbers still *render* correctly, but they extract as invisible junk —
so every `$`, `%`, QPS, and date silently disappears from the PDF text
layer, and therefore from ATS parsing, copy-paste, and screen readers.
For a résumé whose entire thesis is "numbers carry the signal," that is
the single worst failure the document can have, and it is invisible on
screen. (Verified empirically: with `tnum` on, two independent PDF text
extractors returned **zero** digit characters from the résumé.)

Digit-column alignment is recovered structurally where it matters: the
date and metric columns are right-aligned by their grid cell
(`--col-meta-w`), not by monospaced figures, so dropping `tnum` costs
nothing visible. See §8 and the comments in `colors_and_type.css`
(global `font-feature-settings`) and `resume.css` (the `.role-dates`
rule).

---

## 3. Colour

### 3.1 Tokens

| Token         | Hex       | Role                                             |
|---------------|-----------|--------------------------------------------------|
| `--bg`        | `#F7F4ED` | Warm off-white ground. ~4% warm tint, not paper. |
| `--ink-1`     | `#1A1815` | Primary text. Deep warm near-black, never `#000`.|
| `--ink-2`     | `#54504A` | Secondary — dates, locations, role summary, project-metrics line. |
| `--ink-3`     | `#8C857A` | Tertiary — bullet glyphs, the most subdued metadata. |
| `--ink-4`     | `#B6AFA2` | Quaternary — separators (`·`) between sibling inline items, title-line glyphs. (Not the `·`/`· trade-off:` annotation lead-ins — those inherit the bullet's ink.) |
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

**Scope &amp; trade-off annotations take no ink of their own.**
They sit inside a bullet, mid-sentence, so they inherit the
bullet's `--ink-body` along with the rest of its typography
(§5.4). The staff-level thinking on display ("why this decision,
what we gave up") is body copy, not metadata. The
project-metrics line is different — it is a block on its own
line, so it keeps `--ink-2`.

### 3.2 Accent rules

The accent colour exists. It is used in **exactly one place** by
default: the candidate's name. The reason it exists at all is that
the name is the only piece of the document that is unambiguously a
mark of identity — colouring it lightly says "this person" without
shouting "look at me".

To go fully monochrome, add `data-mono` to the root `<html>`
element — the only placement the CSS honours (see §10). The
variant selector in `colors_and_type.css` rebinds `--accent-on` to
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
| `--s-2` |  4pt | name ↔ subtitle                               |
| `--s-3` |  6pt | bullet ↔ bullet                               |
| `--s-4` |  8pt | role-meta ↔ first bullet                      |
| `--s-5` | 12pt | subtitle ↔ contact line; project ↔ project    |
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

**Optical edge alignment.** The 0.72 in margins are box margins, and a
box margin is not what the eye measures — it measures ink. The display
line box carries half-leading plus the ascender-to-ink gap above the
first glyph, so the first glyph's ink used to start ~3.7 pt below the
top margin, while a last line sitting flush on the bottom margin ends
only ~0.3 pt above it. On a filled page the top read airier than the
bottom by ~3.4 pt. Two trims fix this, and both are token-driven:

| Token | Value | Applied to | Removes |
|---|---|---|---|
| `--optical-lead-trim` | 0.123 em of the display size | negative `margin-top` on `.page > :first-child > .name` | the display line's half-leading + ascender gap above the first glyph |
| `--optical-tail-trim` | 1 pt (0.4 pt compact) | negative `margin-bottom` on `.page > :last-child` | the closing line's half-leading below its ink |

The lead trim is em-based so it tracks `--fs-display` and the screen
clamp; it is scoped to `.page > :first-child`, so a `.name` used
elsewhere is unaffected, and in a multi-page flow it applies to page 1
only (pages 2+ break mid-content, where the first line's leading is
content-dependent and unequalisable). The tail trim is absolute pt: the
closing line has no viewport clamp, and the value must not drift with
whichever block it lands on. One tail value cannot be exact for both
documents — the résumé closes on a grid row whose larger left column
sets the row height, the letter on a single small line — so the token is
their midpoint.

Before the tail trim can bite, the phantom trailing margin has to go:
`p { margin: 0 0 var(--s-4) }` leaves 8 pt below the document's last
paragraph, and that margin is part of the flow, so on a filled page the
last line would stop 8 pt short of the bottom margin. `resume.css`
zeroes bottom margins along the final last-child chain (plus the final
`.meta-row`'s other grid item, whose margin would otherwise set the row
height). Earlier rows and multi-paragraph closing blocks — the letter's
`.letter-close` — keep their internal rhythm.

**Measured result** (`preview/variant-contract-check.html`, all four
paper/density variants, both documents): top inset 0.29–0.30 pt,
bottom-to-flow-end −0.09–0.62 pt, left and right 0.00 pt. Every pair
agrees inside 0.5 pt — one hairline rule, the threshold at which a
difference could begin to register at all.

**Sides** are plain symmetry: `--margin-side` is the same left and
right, text is set flush left with a ragged right, and the ink extents
measure 0.00 pt against both content edges with no element overhanging.
The right-aligned meta column is visual alignment inside the same
measure, not a second margin.
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
│  Storage platform · tech lead, team of 8…    Brooklyn, NY      │  ← role-meta
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
  `–` (en dash, **date and numeric ranges only**, never sentence
  punctuation), and `→` (state
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

### 5.3.1 Dash punctuation (the one hard rule of copy)

A dash may live **inside a word or a value**. A dash may never
**connect ideas**. What it governs, strictly, is the two artifacts an
employer receives: the résumé (bullets, role summaries, project
descriptions, annotations) and every sentence of the cover letter.
This documentation, the preview cards' commentary, and code comments
are not sent to anyone, so the rule is not enforced there; following
it anyway is welcome, and never a defect.

**Allowed**

| Case | Example |
|---|---|
| Hyphenated compound | `app-side`, `one-page`, `end-to-end`, `11-month`, `read/write` |
| Technical name whose hyphen is part of the term | `consistent-hash`, `snapshot-restore`, `us-east-2`, `cross-channel` |
| Email address, URL, slug | `anya@castellanos.dev`, `linkedin.com/in/anya-castellanos` |
| Date range, en dash | `Mar 2022 – Present`, `2019 – 2022` |
| Numeric range, en dash | `3–5 engineers`, `1.0–2.0 lines` |

**Forbidden**

- Em dash (`—`) joining clauses, introducing an explanation, or
  hanging an afterthought off the end of a sentence.
- Em dash pairs used as parentheses around an aside.
- En dash (`–`) used as sentence punctuation rather than as a range.
- Hyphen-minus (`-`) standing in for an em dash or a parenthetical
  connector.

**Reject, then rewrite**

| Reject | Write instead |
|---|---|
| "Led the migration — reducing p99 latency by 40%." | "Led the migration, reducing p99 latency by 40%." |
| "Improved the system — and reduced operating cost." | "Improved the system and reduced operating cost." |
| "I am interested in this role – it aligns with my experience." | "I am interested in this role because it aligns with my experience." |
| "The project succeeded - despite the initial constraints." | "The project succeeded despite the initial constraints." |

The repair kit, in order of preference: a comma, a semicolon, a colon
before a genuine explanation, a conjunction (`and`, `because`, `so`,
`while`), parentheses for a true aside, or two sentences. A dash that
resists all six was joining two ideas that should not have shared a
sentence.

Where the joined material is *structural* rather than prose (a role
summary's label and value, an annotation lead-in), the system's
separator is the mid dot: `Storage platform · tech lead, team of 8`.
That is why `.scope` leads with ` · ` and not ` — ` (§5.4).

**Audit before shipping.** Grep the filled document for `\u2014` (em
dash) and for a spaced hyphen (` - `): both should return zero hits.
Grep for `\u2013` (en dash) and confirm every hit sits between two
dates or two numbers.

### 5.4 Scope &amp; trade-off annotations

Two inline annotations exist:

- `<span class="scope">…</span>` — secondary scope metric ("8
  engineers, 11-month project"). Renders prefixed with " · ". The
  lead-in is the mid dot, never an em dash: an em dash here reads
  as an afterthought clause and is forbidden by §5.3.1.
- `<span class="tradeoff">…</span>` — decision / alternative /
  constraint statement. Renders prefixed with " · trade-off: ".

**Both classes are semantic only: they carry no visual treatment.**
`.scope`, `.tradeoff`, and `.annotation-label` inherit the owning
bullet's font family, size, style, weight, line-height, tracking,
and colour. An annotation can begin mid-bullet, and a caption size,
an italic, or a lighter grey there makes one sentence visibly switch
type partway through — the bullet stops reading as a single run. The
visible `·` and `· trade-off:` labels stay, set exactly like the
prose around them. They remain inline (never on their own line) so
the bullet and its reasoning stay visually coupled.

Do not reintroduce `font-size`, `font-style`, `font-family`, `color`,
or `letter-spacing` on these classes — no smaller, lighter, italic,
serif, or mono treatment inside a bullet.
`build/annotation-typography-test.js` (and its browser companion,
`build/annotation-typography-test.html`) fail the build if any of
them come back. `<strong>` inside a bullet is unaffected: genuine
metrics still go to SemiBold (§2.2).

**Label markup.** The prefix label is a real inline span, not
CSS-injected content. The full markup is:

```html
<span class="scope">
  <span class="annotation-label"> · </span>8 engineers, 11-month project…
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
```

Add `.meta-row` to any future block that needs the same alignment
behaviour. Element-specific classes layer typography / spacing /
break rules on top; the grid itself is defined once.

The `.project` block intentionally does **not** use `.meta-row`:
project metrics are a mono-set numeric run that wraps poorly inside
a 1.45 in right column. They stack below the description instead.

### 5.6 Skills block — 3 rows, 16–20 terms

The block is a two-column `dl` (`--col-meta-w` label + `1fr` keywords),
so each `dd` gets ~5.17in of measure. **Budget: 3 rows, one line each,
16–20 terms.** The shipped `resume.html` sample is exactly that — 3
rows, 16 terms (Languages 5, Data & Storage 5, Infrastructure 6). Rows
are the unit to count; a fourth row is already buying page space with
the weakest content on the page.

Selection rule (the generation-side version lives in `SKILL.md §The
Skills block`): filterable nouns only — languages, databases, named
platforms, named infra products. Architecture concepts (Raft, Paxos,
CRDTs, consistent hashing, leader election, gossip, vector clocks) go in
bullets, where they are evidence; in this block they are padding.
Commodity tooling and region lists are out.

**Do not collapse the block to a single unlabelled keyword run.** The
`dt` labels are load-bearing for parsing, not decoration: résumé
parsers extract skills into a structured field or tag set keyed off the
section header and its category rows, and that is a different retrieval
path from full-text search. Flattening saves a fraction of one line and
gives up the tag path. **Do not delete the block either** — its content
is the terms that exist nowhere else on the page (in the shipped
sample, 12 of the 16).

### 5.7 Subsection heads

For groupings *inside* a section — "Open Source" under Experience,
"Talks" under Selected Systems — use the subsection-head pattern:

```html
<div class="subsection-head">
  <h3>Open Source</h3>
  <span class="rule" aria-hidden="true"></span>
</div>
```

It renders as italic 9.5 pt at `--ink-meta` with the same hairline
rule. Quieter than `.section-head`, on purpose: it groups, it
doesn't divide.

**Write its bullets self-identifying.** A subsection carries no company
and no dates, so a parser that segments Experience by employer files
these bullets under the role above. Naming the subject in the bullet
itself (`Maintainer of shardmap, …`, `Committer on arrow-rs, …`) makes
the line true either way. Copy discipline, no visual cost — see §8.1.

### 5.8 Header subtitle — the one home for education

The line under the name is the résumé's subtitle, and it carries
exactly one content pattern:

```
[current professional role] · [highest completed degree], [institution]
```

```html
<p class="tagline">
  <span class="subtitle-role" itemprop="jobTitle">Staff Engineer</span>
  <span class="sep" aria-hidden="true">·</span>
  <span class="credential">B.S. Computer Science, Carnegie Mellon University</span>
</p>
```

**There is no Education section in this system.** No heading, no
rule, no bottom row, no early-career exception, no toggle, no
variant — one permanent placement, so a résumé never has two
credible homes for the same fact. A staff-level reader wants the
degree as provenance, not as a block competing with the work.

Rules:

- **Role first, credential second**, joined by the system's mid dot
  (`.sep`) — never a dash (§5.3.1). Degree and institution are
  separated by a comma, in that order.
- **No degree documented ⇒ render the role alone.** Drop the
  separator and the `.credential` span; change nothing else. That is
  the only other valid shape of this line.
- **Both halves are plain text inside `<main>`**, in the normal flow,
  so every ATS reads them as ordinary line content. Nothing about the
  credential is an image, a pseudo-element, or chrome.
- **One treatment across the whole line.** `.subtitle-role` and
  `.credential` inherit the subtitle's family, size, style, weight,
  tracking, and ink — same principle as the inline bullet annotations
  (§5.4). The line must read as a single run, not as a label plus a
  footnote.
- **The span is `.subtitle-role`, never `.role`.** `.role` is the
  Experience block component (§5.2); naming the subtitle span `.role`
  puts header text inside that block's margin, break, and `:last-child`
  rules, and makes every consumer's `.role { … }` restyle the header.
  No `.tagline` descendant may reuse a block-component class name.
- **Never a specialisation or marketing tagline.** "Python backend,
  data integration &amp; full-stack delivery", "distributed systems
  &amp; storage infrastructure", "driving growth through data" — all
  forbidden. The subtitle states what the candidate *is* and what
  they *completed*; the bullets carry the specialisation as evidence.
- **One line.** Keep it under ~70 characters so it sets on one line
  at 11pt inside the type area; abbreviate the degree (`B.S.`,
  `M.S.`, `Ph.D.`) rather than the institution. `text-wrap: pretty`
  handles the rare unavoidable wrap.
- Certifications, coursework, bootcamps, honours, GPA, and graduation
  dates do **not** appear anywhere. "Highest completed degree" means
  completed; an in-progress degree is not rendered.
- **Known parse cost, accepted:** strictly section-segmenting ATS
  stacks map education from a *heading* and will file this line as part
  of the title instead. Full-text parsers find it wherever it sits, and
  application forms collect education separately — see §8.1.

---

## 6. Density rules

| Length goal | What "fits" looks like                              |
|-------------|-----------------------------------------------------|
| 1.4 pages   | 3 roles + Selected Systems + Skills, with the oldest role collapsed and 4–5 bullets on the current one; page 2 ends ~40% down. Intentional, and the easiest shape to hit from a trim. |
| 1.0 page    | Reachable by cutting content, not by tightening type. The cuts, in order of how little they cost: drop `Selected Systems` when it restates bullet metrics (the largest single recovery, and it costs zero searchable terms); collapse the oldest role to a dateline + one summary line; trim the skills block to 3 rows. Past that you are deleting evidence — say so rather than doing it silently. |
| 2.0 pages   | Same blocks with denser bullets, or a subsection head (§5.7) added under Experience; page 2 ends near the bottom margin. Also intentional — **this is what the shipped `resume.html` sample is calibrated to** (measured 1.91 type areas in Chrome with the CDN families: page 2 ends ~91% down, leaving room for a role block to shift on a break without spilling to a third sheet). |

Block sizes are not quoted here in pixels on purpose: they depend on
the renderer, the density variant, and whether the Google Fonts CDN
served the real families or a fallback. Measure the actual render if
you need a number, and state the renderer alongside it.

**Anything between these shapes is a defect, not a length.** A résumé
at 2.05 pages that drops three lines onto a third sheet, or a letter at
1.02 pages that pushes only its signature over, reads as a mistake at a
glance. Land on a listed shape by cutting copy — or, for a small
overflow, by the measured `data-density="compact"` path in §6.0.

The template **does not** compress content to fit one page. Staff+
candidates have content. Trying to squeeze it loses signal.

### 6.0 Density ownership

There is exactly **one** density variant, `data-density="compact"`
(§10.5), and it is a **measured-fit fallback**:

- Default density is the default. It is the calibrated appearance of
  the system and does not change to make more content fit.
- Compact is applied only *after* a render has measured an overflow —
  never speculatively.
- There is no second tier and no per-section density.
- Compact is not a replacement for editing content. If it still
  overflows, cut material.
- In host-driven consumers (**Infinite Canvas**), the host owns this:
  the agent emits a bare `<main class="page">…</main>` with no
  `data-*` variant attributes; the app sets root attributes, renders
  default density first, and enables compact only on a measured
  overflow.

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
points, section dividers, separators (`·`), the en dash in ranges, and
`→` are the entire visual vocabulary. The em dash is not part of it
(§5.3.1).

If a future variant needs a single mark — e.g. a small monogram —
it must be ink, embedded as text, and placed in body flow.

---

## 8. Accessibility &amp; PDF output

- Render via Chrome/Chromium "Save as PDF" or `puppeteer` with
  `tagged-pdf` enabled.
- Confirm: `Ctrl+A` → copy → paste into plain text round-trips all
  content in reading order. Test after every major change. **Pay
  specific attention to digits** — a font feature (`tnum`) can make
  numbers render but not extract (see §2.4). The round-trip is only
  "verified" if every `$`, `%`, and date survives the paste. Grep the
  pasted text for the figures you expect; do not eyeball it.
- The header (name / subtitle / contact) lives inside `<main>`, not
  the page's chrome — parsers that drop chrome will still see contact info,
  and the subtitle's degree + institution (§5.8) with it.
- Semantic landmarks: `<main>`, `<header>`, `<section aria-labelledby>`,
  `<article>`, `<time datetime>`. Roles are `EmployeeRole`
  microdata; the person is `Person` microdata.
- Where the rendering engine supports it, emit PDF/UA-1 with tagged
  content for EU EAA compliance.

### 8.1 Parse-safety contract

Everything in this section is **free**: it costs the design nothing
visually. That is the filter. The system does *not* trade away its
typography for parser convenience — no Arial, no white background, no
left-aligned dates, no keyword block, no duplicated hidden text (which
reads as keyword stuffing and gets a document rejected outright). What
follows is only the set where the parse-friendly choice and the
beautiful choice are the same choice.

**Hard hazards — never present in a shipped document.** These are
checked mechanically by `build/ats-parse-test.js`, which fails the
build:

| Hazard | Why it breaks parsing |
|--------|-----------------------|
| `<table>` anywhere | Cell-by-cell reading order; a two-column table interleaves unrelated lines. |
| `<img>` / `<svg>` / `<canvas>` carrying text | Renders, extracts as nothing. |
| `position: absolute` / `fixed` on content | Visual order stops matching source order, and extraction follows source. |
| `column-count` / `column-width` | Real columns interleave on parse (§5.1). |
| Hidden or 0px text (`visibility: hidden`, `opacity: 0`, `font-size: 0`) | Reads as keyword stuffing, not as content. |
| `font-variant-numeric: tabular-nums` / `"tnum"` | Every digit drops out of the PDF text layer (§2.4). This one is catastrophic and invisible. |
| CSS `content` carrying meaning | Dropped on copy in many engines. Decorative only — the bullet glyph is the sole sanctioned use (§5.4). |
| Contact details outside `<main>` | Parsers that discard chrome discard the way to reach the candidate. |
| `&nbsp;` in candidate copy | Extracts as U+00A0; `"38 ms"` stops matching a pattern that expects an ASCII space. Use `.nowrap` (below). |

**The `.nowrap` utility.** Keeping a value with its unit is
typographically necessary (`38 ms` must never break across lines), and
`&nbsp;` is the reflex. Use `class="nowrap"` instead:

```html
<strong class="nowrap">p99 38 ms</strong>
<span class="nowrap">19 PB</span>
<dt class="nowrap">Data &amp; Storage</dt>
```

Identical rendering — same glyph, same advance, same unbreakable pair —
and an ordinary space in the text layer.

**Typography that stays, and what it costs.** These extract as
non-ASCII and are kept anyway, because the alternatives are uglier and
the cost is bounded:

- `→` for a state change (`2.1 s → 340 ms`). Both figures still extract
  as digits; only the relationship between them is a symbol.
- `−` (true minus) in a delta (`−74% ingest cost`), `≤` for a bound.
  A pattern looking for `-74%` will miss it, so **never let a symbol be
  the only carrier of a claim**: if the direction of a number matters to
  a screener, say it in words in the same line (`ingest cost down 74%`).
  That is a copy rule, not a design change.
- `·` mid dots as separators. They extract as themselves, which is
  correct — they are punctuation, not content.

**Section-segmenting parsers — two known, accepted costs.**

1. **The degree lives in the header subtitle (§5.8), not in an
   Education section.** Full-text parsers (modern Workday, Greenhouse,
   HireAbility) find `B.S.` / `University` wherever they sit. Older
   strictly section-segmenting stacks map education *from a heading*,
   and will file the degree as part of the title line or skip it.
   Accepted: the placement is a permanent design decision, application
   forms collect education separately, and the alternative is a section
   the system deliberately does not have.
2. **Subsection heads (§5.7) carry no company or dates**, so a parser
   that segments strictly by employer attributes their bullets to the
   role above. Mitigate in copy, at no visual cost: every bullet under
   a subsection names its own subject (`Maintainer of shardmap, …`,
   `Committer on arrow-rs, …`), so the line is correct no matter which
   employer it is filed under.

**Free wins outside the markup.** Name the delivered file
`Firstname-Lastname-Resume.pdf` (parsers and recruiters both read the
filename), keep section labels conventional (§2.3), and render one
PDF, not a scan or an image export.

---

## 9. JSON Resume schema mapping

The HTML structure is a 1:1 mirror of JSON Resume v1.0.0 with the
following namespaced custom fields. All custom fields use the `x_`
prefix per JSON Resume convention.

| JSON path                                | HTML target                              |
|------------------------------------------|------------------------------------------|
| `basics.name`                            | `.name`                                  |
| `basics.label` (current role only)       | `.tagline .subtitle-role`                |
| `basics.email`                           | `.contact a[itemprop=email]`             |
| `basics.phone`                           | `.contact a[itemprop=telephone]` — rendered `(NNN) NNN-NNNN`, wrapped in `<a href="tel:+1…">` |
| `basics.location.{city,region}`          | `.contact [itemprop=addressLocality]` — **optional; see the privacy rule below** |
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
| `education[0].{studyType, area}` + `.institution` | `.tagline .credential` — rendered `"<degree>, <institution>"`. Highest completed degree only; **no Education section exists** (§5.8). Omit the span entirely when no degree is documented. |

Date normalisation: incoming `YYYY-MM` → rendered "Mon YYYY"; incoming
`YYYY` → rendered "YYYY"; null `endDate` → "Present".

### 9.1 Contact privacy — location is opt-in only

`basics.location` is **optional**, and the candidate's city/region may
be rendered in the contact line (résumé header or cover-letter
letterhead) **only when it was explicitly supplied as candidate contact
data.**

**Never infer it.** Not from the job posting or its location, not from
the employer's headquarters, not from a prior role's office, not from a
school, not from an area code, a timezone, or a profile URL. If the
value was not given, omit the `addressLocality` span and its adjacent
`.sep` entirely — email · phone is a complete, correct contact line
(and the shape both shipped samples use), and the flex layout closes
the gap with no visual artefact.

`work[].location` (`.role-location`) is different: it is an employment
fact about that role and may be rendered when supplied with the role
entry. It is still never a source for `basics.location`.

---

## 10. Variants

The system ships four opt-in variant attributes: `data-print`,
`data-page`, `data-mono`, `data-density`. All are defined in
`colors_and_type.css` under "Variants".

### 10.0 The canonical variant contract — root only

**Every variant attribute is valid only on the root `<html>`
element.** Every selector in `colors_and_type.css` and the named-page
rules in `resume.css` are anchored with `:root`, so an attribute on
`<main class="page">`, on `<body>`, or on any other ancestor has **no
effect**. There is no legacy fallback, no `.page`-level branch, and no
`:has()` compatibility rule — they were removed. One document, one
configuration.

```html
<html lang="en" data-print="dual-pdf" data-page="a4" data-density="compact">
  …
  <main class="page">…</main>
```

Variants compose cleanly — `data-page="a4" data-mono
data-density="compact" data-print="dual-pdf"` on the root is a valid
combination. **The two `data-print="…"` values are mutually
exclusive.** Pick one: `ink-only` for a single-state white-paper PDF,
or `dual-pdf` for a two-state PDF that shows cream on screen and
prints white. `dual-pdf` is the default in `resume.html` and
`cover-letter.html`.

Why root-only: the tokens are custom properties, so they must be
redefined where `html` and `body` can read them (the print background
is painted on `html, body`). Subtree placement used to require mirror
selectors and a `:has()` branch to patch that up, and permitted
mixed / nested placements that half-applied a variant. Anchoring at
`:root` makes each variant one flat rule with no failure mode.

**Regression harness.** `preview/variant-contract-check.html` probes the
contract in isolated iframes: named page + `--fs-body` / `--page-w` /
`--margin-top` for all four page-selection states, the print `--bg`
for `ink-only` / `dual-pdf` (it rewrites `@media print` to `all` so the
engine actually evaluates the print cascade), and legacy placements on
`<main class="page">` / `<body>`, which must all report default values.
It also lints both stylesheets for `:has(`, `.page[data-…]`
self-selectors, and any variant selector not anchored at `:root`. Open
it after touching a variant rule.

**Host-driven consumers.** When a host application owns the document
shell — **Infinite Canvas** is the reference consumer — the generated
output is exactly a bare `<main class="page">…</main>` with no `data-*`
variant attributes anywhere inside it. The host sets the root
attributes, renders default density first, and enables
`data-density="compact"` only after measuring an overflow.

### 10.1 A4 paper

```html
<html data-page="a4">
```

Recomputes `--page-w`, `--page-h`, and the margin tokens so the
measure stays in editorial range on A4 stock (210 × 297 mm,
~16 mm sides, ~18 mm head/foot). The physical paper size is
selected by CSS named pages declared in `resume.css`:

```css
@page letter         { size: Letter; margin: 0.72in 0; }
@page a4             { size: A4;     margin: 18mm 0; }
@page letter-compact { size: Letter; margin: 0.6in 0; }
@page a4-compact     { size: A4;     margin: 15.24mm 0; }

.page                                              { page: letter; }
:root[data-page="a4"] .page                        { page: a4; }
:root[data-density="compact"] .page                { page: letter-compact; }
:root[data-page="a4"][data-density="compact"] .page { page: a4-compact; }
```

Four states, four rules. Specificity orders them: the compact rule
(0,3,0, declared after the plain letter/a4 rules) wins over `a4`, and
the two-attribute `a4-compact` rule (0,4,0) wins over both — so
`<html data-page="a4" data-density="compact">` correctly selects the
compact A4 page.

Chromium 85+ honours `page: <name>` on an element + a matching
`@page <name>` rule, so the root attributes fully control paper
size with no top-level override. Engines without named-page
support fall through to the default `@page` block (Letter).

### 10.2 Monochrome (no oxblood accent)

```html
<html data-mono>
```

Rebinds `--accent-on` to `--ink-1`. The candidate name renders in
the same deep ink as the body text. Useful for B&W laser pipelines,
strict-formatting clients, or recipients who explicitly request no
colour.

### 10.3 Print: ink-only

```html
<html data-print="ink-only">
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
<html data-print="dual-pdf">
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
1.17.1 is loaded from CDN in the browser
(`https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js`)
and from the `pdf-lib` npm package in Node. Pass `{ cream: '#XXXXXX' }`
if you've forked `--bg`.

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
<html data-density="compact">
```

The single lever for "this is 1.1 pages and I want 1.0". Body type
drops 10.25 → 9.75 pt; leading 1.45 → 1.35; block-spacing tokens
(`--s-6` / `--s-8` / `--s-9`) drop ~25%; page head/foot margins
shrink 0.72 → 0.6 in. Roughly 6–9 lines of body reclaim per page.

Deliberately untouched: `--fs-display` (the name), `--col-meta-w`
(date strings keep the same metrics), `--rule-weight`, accent,
families. Visual identity unchanged — just tighter.

It is the system's **one** measured-fit fallback, not the default and
not a tier in a scale — see §6.0. If compact still overflows, the
content is the problem; trim a bullet. There is no
`data-density="ultra-compact"`.

### 10.6 Running footer

Not a variant per se, but documented here: pages 2+ render a
mono page indicator (`2 / 3`) in `--ink-quiet` at the bottom-right
of the page via CSS `@page` margin boxes. Page 1 is suppressed via
`@page <named>:first` so a one-page resume never shows a counter.
All four named pages carry it — `letter`, `a4`, `letter-compact`,
`a4-compact`.

If the rendering pipeline strips `@page` margin boxes (some legacy
print engines), the resume still prints — just without the page
indicator. No content depends on it.

### 10.7 Page-margin model — why vertical margins live on `@page`

The page margins are split across two mechanisms, deliberately:

- **Top / bottom margins live on `@page`** (`margin: 0.72in 0` for
  `letter`, `18mm 0` for `a4`). Page margins are the one thing CSS
  paged media repeats natively on *every* page.
- **Side margins live as `.page` padding** (`padding: 0 var(--margin-side)`),
  so they stay token-driven — `a4` (16mm) and `data-density="compact"`
  recompute the measure through `--margin-side` without touching the
  vertical rhythm.

**Do not move the vertical margins back into `.page` padding.** Padding
on an element that fragments across pages is applied only at the first
fragment (top) and the last fragment (bottom). A résumé that runs to
two pages then renders page 2 with its content jammed against the top
paper edge — no top margin at all. Putting the vertical margins on
`@page` is what makes page 1 and pages 2+ identical. The `@page`
vertical margin also gives the running-footer margin box (§10.6) a real
band to render in.

Caveat: `@page` rules can't read CSS custom properties, so the values
are literal. Compact density is therefore handled with dedicated named
pages — `letter-compact` (`0.6in 0`) and `a4-compact` (`15.24mm 0`) —
which mirror the `--margin-top` / `--margin-bot` overrides in the
`:root[data-density="compact"]` block, and are selected by the
root-anchored `page:` rules in §10.1. Compact **does** shrink printed
head/foot margins on both paper sizes, matching §10.5. Side margins
(the measure) stay on `.page` padding and respond to every variant
through tokens.

---

## 11. Cover letter

The system ships a second document surface: `cover-letter.html`
(+ `cover-letter.css`). It loads `colors_and_type.css`, then
`resume.css` (for the shared page chrome, paged-media model, the
letterhead component, `.meta-row`, and `.sep`), then `cover-letter.css`
last. It is the same paper, ink, palette, and page geometry as the
résumé — a matched pair, not a separate design.

### 11.1 The one serif-body surface

The résumé sets body copy in **Inter** because it is a scannable data
grid. The cover letter is the system's only **long-form prose** surface,
so its body is set in **Source Serif 4** at reading size (10.5pt / 1.6) —
the "book interior" move from the same Stripe-Press / Pentagram lineage.
Same three-family palette, same ink, a different document voice. This is
the **single sanctioned use of the display serif at reading size**. Do
not carry serif body back into the résumé, where Inter's even colour is
load-bearing for the 6–10-second scan.

### 11.2 Anatomy

```
Letterhead   ── identical component to the résumé header
             (.resume-header / .name / .tagline / .contact),
             oxblood name, contact in body text.
─── hairline rule (.letterhead-rule) ───
Date         ── right-aligned, --ink-meta, proportional figures.
             Rhymes with the résumé's right-aligned date column.
             **Pegged to the render month, never authored** (§11.6).
Recipient    ── <address>: addressee (.recipient-name — a named person
             when you have one, else "Hiring Team"), then company,
             then the role being applied for (.recipient-line ×2).
             The addressee line carries the only --ink-body weight;
             the two lines under it are --ink-meta.
Salutation   ── "Dear …,"
Body         ── 3–4 paragraphs, Source Serif 4. Specifics over
             adjectives, same as the bullets: a number per claim
             where one exists. <strong> (SemiBold, never 700) on
             only the one or two headline figures.
Close        ── valediction + signature (the name, nothing else),
             wrapped in .letter-close.
```

### 11.3 Accent &amp; the close

The oxblood accent appears **exactly once** on the page — the
letterhead name — same restraint as the résumé. The **signature is
ink** (Source Serif 4, SemiBold, one size down from the name): its
distinction is carried by *type*, not colour. Repeating the accent at
the foot would tip it from a quiet identity mark toward a brand colour,
and "used in exactly one place" is the rule that keeps it confident
rather than decorative. Do not colour the body, the recipient, or the
signature.

**The close is the valediction and the name, full stop.** No role
caption, no "candidate" line, no credential under the signature: the
letterhead subtitle (§5.8) already carries role and degree, and a
second title line at the foot turns a letter into a business card.

`.letter-close` carries `break-inside: avoid` so the valediction and
signature never split across a page break — the structural cure for the
"*Sincerely,* on page 1, name orphaned on page 2" failure. A well-formed
one-page letter never triggers it, but the protection is load-bearing
for any letter that runs long.

### 11.4 Content rules

- Length is **one page**. A cover letter that spills to two pages is
  too long; cut a paragraph, not the margins.
- Numbers carry the signal here exactly as in the résumé bullets. The
  shipped Anya Castellanos / Vireo Data figures are **sample data**
  (the same numbers as the résumé bullets, by design) — replace them
  with the candidate's real metrics before sending.
- No icons, no colour blocks, no second accent, no closing P.S. The
  typographic vocabulary is the résumé's: `·`, `–` (ranges only), `→`.
- **No dash connects clauses in the letter's sentences.** Long-form
  prose is where em dashes creep in hardest, and where they read most
  strongly as machine-written. §5.3.1 applies to every sentence here;
  the repair is a comma, a conjunction, or two sentences.

### 11.5 Short letters — `data-letter="centered"`

```html
<html lang="en" data-letter="centered">
```

Equal top/bottom margins hold only when the block reaches the bottom
margin (§4.4). A letter that runs **≲⅔ of the type area** leaves all
its slack at the foot and reads as though it slid off the top of the
sheet. For correspondence, the editorial answer is to hang the short
letter optically centred in the type area.

| | |
|---|---|
| Scope | **Cover letter only.** The rule lives in `cover-letter.css`, which the résumé does not load — the scoping is structural, not conventional. A résumé is read top-down as a data grid and is *never* centred. |
| Contract | Root-only and opt-in, same as the other four variants. |
| When to set | Only after measuring the rendered letter at ≲⅔ of the type-area height — the same measure-then-set discipline as `data-density="compact"` (§6.0). |
| Mechanism | `align-content: safe center` on `.page` — **not** flex. Switching `.page` to a flex container disables margin collapsing, which the optical trims (§4.4) live in; measured, it grew a full letter's page box by ~9 pt, enough to tip a one-page letter onto a second sheet. `align-content` centres block children inside a definite height and leaves the formatting context — and every other measurement — untouched. `safe` leaves negative free space alone, so a letter that fills or overflows the page is left exactly as it was and can never be pushed off the top edge. Degradation is graceful at every length: the shorter the letter, the more it centres. |
| Print | Print drops the screen page box (`min-height: auto`; vertical margins move to `@page`), leaving no definite height to centre in. The print branch restores one as `--page-h − --margin-top − --margin-bot`; because the margin tokens track the values `@page` uses, that single `calc` covers letter, a4, letter-compact and a4-compact. |
| Ink balance | The optical lead trim (§4.4) still applies inside the letterhead, so a centred letter keeps equal ink-to-edge distances at top and bottom as well as equal slack. |

---

### 11.6 The letter date is pegged to generation time

The date is the one field in either document that goes stale on its
own, so it is **never authored**. `cover-letter.html` ships the
element empty and fills it from the system clock at render time:

```html
<p class="letter-date"><time id="letter-date" datetime=""></time></p>
<script>
  (function () {
    var el = document.getElementById('letter-date'), d = new Date();
    el.setAttribute('datetime', d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
    el.textContent = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  })();
</script>
```

- **Month and year only** ("August 2026"), matching the résumé's date
  column. A day-precise date dates the letter to the hour and invites
  a stale mismatch with the send.
- **Both halves are set**: the visible text and the machine-readable
  `datetime` (`YYYY-MM`), so the markup stays semantic.
- **The script sits next to the element**, runs synchronously before
  paint, and is the only script in either document. No flash, no
  layout shift, nothing to load. The PDF pipeline (Chrome / Puppeteer)
  executes it before printing, so the produced PDF carries the render
  month.
- **The source element is empty on purpose.** A typed fallback month
  is exactly the hard-coding this replaces: it would print silently
  and wrongly in the one case the fallback exists for. An agent
  filling this template for a non-JS pipeline substitutes the month
  itself, at fill time.
- The résumé carries no document date at all — its dates are
  employment facts, and `Present` on the current role is what makes it
  self-updating.

---

## 12. What this template is *not*

- Not a one-pager. Not a creative CV. Not a portfolio site.
- Not driven by colour, illustration, or graphic devices.
- Not optimised for screen reading at desktop sizes — it is optimised
  for an 8.5×11 PDF that a recruiter scrolls through.
- Not a place to express personality through layout. Personality
  lives in the bullets.

When in doubt: do less, and do it more carefully.
