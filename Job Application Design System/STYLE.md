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

| Token        | Size      | Weight | Leading, as applied | Tracking | Used on              |
|--------------|-----------|--------|---------------------|----------|----------------------|
| `--fs-display` | 28pt    | 600    | `--lh-display` 1.05 | -0.012em | candidate name       |
| `--fs-h1`      | 18pt    | —      | —                   | —        | (reserved — no component uses it) |
| `--fs-h2`      |  9pt    | 500    | `1` (tight box, so the hairline rule sits at cap mid) | 0.14em uppercase | section headers (Experience, Skills…) |
| `--fs-h3`      | 11pt    | 600    | inherited (`--lh-body` 1.45) | -0.005em | role title, company, project name |
| `--fs-body`    | 10.25pt | 400    | `--lh-body` 1.45    |  0       | bullets, paragraphs |
| `--fs-small`   | 9.5pt   | 400    | inherited 1.45; Skills `dd` uses `--lh-snug` 1.35 |  0 | dates, locations, role meta, Skills |
| `--fs-caption` | 8.75pt  | —      | —                   | -0.005em | block-level captions (reserved) — **never** the inline `.scope` / `.tradeoff` spans |
| `--fs-mono`    | 9pt     | 400    | inherited           | -0.005em | technologies, project metrics |
| `--fs-letter-body` | 10.5pt | 400 | `--lh-letter` 1.6   |  0       | cover-letter body + valediction (compact: 10pt / 1.5 — §11.7) |
| `--fs-signature`   | 15pt   | 600 | 1.1                 | -0.012em | the letter's signature (compact does **not** change it) |

**Leading is set by the component, not implied by the size token.**
Only three leading tokens ship — `--lh-display`, `--lh-snug`,
`--lh-body` — plus `--lh-letter` for the one prose surface; a size
token carries no leading of its own. (An earlier revision of this table
listed a per-token line-height for every row, which most components
never applied. The column above says what the shipped CSS actually
resolves to.)

The body sits at **10.25pt**, deliberately between the 10pt many
templates use (cramped) and 11pt (sparse for staff+). At 0.78in side
margins this gives 70–75 characters per line — Butterick's editorial
sweet spot. That figure describes a single line of running prose (the
cover letter's paragraphs); it is not the bullet budget. A bullet's
proportional-font line, with mixed short and long words, comfortably
holds more than 75 characters before it wraps — the bullet-specific,
renderer-verified number is §5.4's 180-character budget, not 2× this
figure.

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

The hexes in this table are **guarded**: `build/token-sync-test.js`
parses `colors_and_type.css` and fails if any row here, the PDF module's
cream default, or a `@page` footer literal disagrees with the token.

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
| `--s-3` |  6pt | bullet ↔ bullet; role header ↔ role meta; Skills row gap |
| `--s-4` |  8pt | role-meta ↔ first bullet; default paragraph gap; subsection-head bottom |
| `--s-5` | 12pt | subtitle ↔ contact line; project ↔ project; heading ↔ rule gap |
| `--s-6` | 16pt | section header ↔ section body; letterhead bottom; valediction ↔ signature |
| `--s-7` | 20pt | (reserved — no current caller)                |
| `--s-8` | 24pt | role ↔ role within a section                  |
| `--s-9` | 32pt | header block ↔ first section (`.resume-header`) |
| `--s-10`| 40pt | (reserved — no current caller)                |

`--s-0` was removed — `0` needs no token, and nothing referenced it.
So were `--lh-tight` and `--lh-loose`: an unused leading token invites a
component to reach for a fourth value that the density variant then
fails to track. The three rows marked reserved above are kept and
marked as such in the CSS itself.

### 4.2 Vertical-rhythm scale — baseline-keyed block spacing

`--baseline` is computed as `calc(var(--fs-body) * var(--lh-body))`
— one line-box of body text, ~14.86 pt by default. The `--vr-*`
tokens are multiples of `--baseline` and are used wherever vertical
rhythm matters (section ↔ section, header block ↔ first section,
subsection heads).

| Token       | = baseline × | ~pt   | Used between                            |
|-------------|--------------|-------|-----------------------------------------|
| `--vr-half` | 0.5          |  7.4  | (reserved — no current caller)          |
| `--vr-1`    | 1            | 14.9  | subsection-head top gap; letterhead rule ↔ date ↔ letter body |
| `--vr-1-5`  | 1.5          | 22.3  | letter body ↔ close (`.letter-close`)   |
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

### 5.2a Role-row length budgets

The role block's two left cells are the highest-frequency single-line
rows on the page — 3–5 roles × 2 rows — and until 2026-08-21 neither had
a published length. A `.role-title-line` that wraps costs one line *per
role*, silently.

| Row | Budget | Measured floor [M] |
|-----|--------|--------------------|
| `.role-title-line` (Title · Company) | **56 chars** | 60 |
| `.role-summary` | **70 chars** | 75 |

[M] Letter/default, the tightest of the four configs. Measured in
`build/line-yield-check.html` by growing whole words over 8 shuffled
orders of a low-breakpoint compound vocabulary and taking the tightest
result; the published budget sits below that floor with margin.
Enforced statically by `build/fit-estimate-test.js`.

**`min-width: 0` is not the fix, and must not be added.** `.meta-row` is
`grid-template-columns: 1fr auto` with `.role-dates`/`.role-location`
set `white-space: nowrap`, which looks like the classic min-content
overflow trap. It is not: the `1fr` track measures ~518px against a
~651px content width, so roughly 400px of slack means the min-content
floor never binds. A/B measured 2026-08-21 — the title budget is
identical (60–70) with and without `min-width: 0`. The missing budget
was the bug, not the grid.

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
- **Every bullet stands alone.** Recruiters and ATS previews scan bullets
  out of sequence, so an `<li>` may not depend on the preceding bullet or
  role summary for its subject. Repeat the shortest concrete noun phrase
  for the platform, database, system, dataset, or actor; never write
  backward references such as "those platforms" or "that database."
  Pronouns are acceptable only when their antecedent is unambiguous inside
  the same bullet. In data-flow bullets, name the producer, consumer, vendor,
  agency, database, or platform instead of writing "their APIs" or "data they
  returned." Put temporal modifiers beside the action they modify; avoid a
  late "after testing" that can attach to the wrong verb.
- Each bullet should contain at least one specific number (QPS,
  p99, team size, $ volume, percentage change). Adjectives without
  numbers are wasted lines. A `.tradeoff` annotation (§5.4) is **not**
  a substitute for that number — it is an optional add-on for a
  bullet that is already carrying evidence, reached for only when the
  bullet describes a genuinely decision-defining alternative or
  constraint. A bullet with no number and no real trade-off to report
  is a bullet to rewrite or cut, not one to pad with an annotation.
- Acceptable bullet length: 1.0 – 2.0 wrapped lines. Avoid the
  3-line bullet — it reads as a paragraph. Mechanically, this is one
  180-visible-character budget that applies to **every** bullet,
  annotated or not — see §5.4 for the number and how it was measured.
- **No colon-led inventory, no overloaded sentence, no reused
  metaphor, no broken parallelism, no unearned generalization.**
  §11.2.3 states these five rules
  once, for every string the system writes, and they bind résumé copy
  — bullets, role summaries, project descriptions — exactly as they
  bind the letter. On the résumé the colon rule is the one most often
  broken: a bullet or role summary whose colon is followed by three or
  more parallel technology phrases is a keyword list wearing a
  sentence's punctuation. Name the technologies where they carry the
  claim instead, and cut the ones that only pad it. The parallelism
  rule catches a related tic in role summaries and process bullets: an
  endpoint range that pairs a noun phrase against a gerund phrase. Repair by
  putting both ends in the same grammatical form. Even when both endpoints
  are nouns, do not hide a multi-step workflow inside an opaque range; name
  the supported actions directly. The
  generalization rule catches the matching tic in a
  role summary that concludes about a career rather than about the
  role: one role's evidence supports "the broader pattern in the
  role", never "most of my work", and a summary noun like "shape" or
  "pattern" must name the responsibility it stands for in the same
  sentence.

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
sentence. (A colon used this way introduces one explanatory clause; a
colon introducing three or more inventoried items is a separate,
forbidden pattern regardless of the dash question — see §11.2.3.)

Where the joined material is *structural* rather than prose (a role
summary's label and value, an annotation lead-in), the system's
separator is the mid dot: `Storage platform · tech lead, team of 8`.
That is why `.scope` leads with ` · ` and not ` — ` (§5.4).

**Audit before shipping.** Grep the filled document for `\u2014` (em
dash) and for a spaced hyphen (` - `): both should return zero hits.
Grep for `\u2013` (en dash) and confirm every hit sits between two
dates or two numbers.

### 5.3.2 Bullet ordering within a role (relevance, not chronology)

Bullets are written once per candidate but **ordered once per
application.** The same role's bullet set is re-sequenced for every
job description, because "most important" has a different answer for
every recipient.

**The rule:** within each role, the first bullet is the one whose
evidence is most persuasive to *this* job description — not the one
that happened first, not the one that mattered most to the *past*
employer, and not the one with the largest raw number.

Rank by alignment with what the job description actually asks for:
its stated responsibilities, its named technologies, the business
problem it's hiring to solve, its seniority signals (scope, team
size, ambiguity), and the kind of measurable outcome it seems to
value. A bullet that is a strong technology match for this job but
was a minor part of the candidate's actual role can outrank a bullet
that was the candidate's proudest achievement but has no bearing on
what this employer needs.

**What ranking must never do:**

- **Never reorder to imply relevance that isn't there.** Promoting a
  bullet is a claim about its relevance to this job; if the
  connection is a stretch, fix it with honest framing inside the
  bullet, not by moving it up the list.
- **Never change what happened.** Reordering, not rewriting. A
  bullet's facts, numbers, and scope stay exactly as authored; only
  its position in the list changes per application.
- **Never rank by chronology.** The most recent bullet is not
  automatically first; a two-year-old bullet that matches the JD
  beats a last-quarter bullet that doesn't.
- **Never rank by raw metric size alone.** A 10x number that answers
  a need this employer doesn't have is weaker evidence here than a
  modest number that answers one they do.

The 3–6-bullets-per-role budget (§5.3) is unaffected — this section
governs order, not count. Every bullet still needs its own number and
still passes the same length budget (§5.4) regardless of position.

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
`build/annotation-typography-check.html`) fail the build if any of
them come back. `<strong>`/`<b>` inside a bullet is a separate rule
(§5.4.1, below): the annotation spans are semantic-only by inheriting
the bullet's type; a bullet's own `<strong>`/`<b>` is semantic-only by
the same mechanism, so the whole bullet — main sentence, annotation,
and any marked-up metric — sets in one uniform weight.

#### 5.4.1 No inline emphasis inside a bullet

`<strong>` and `<b>` may still appear inside `.highlights li` — the
host app keys off them (and any `data-achievement-id` attribute they
carry) as semantic metadata for individual achievements — but they
render at the surrounding bullet's own weight and colour, not
SemiBold. A bolded metric mid-sentence draws the eye to a number
instead of the claim, and once one bullet bolds a figure the reader
starts scanning for bold instead of reading — the opposite of the
quiet-confidence voice.

This is scoped to `.highlights li b, .highlights li strong` in
`resume.css` and does **not** change the global `b, strong` rule in
`colors_and_type.css`: candidate name, role title, employer, and
project name stay SemiBold, and cover-letter emphasis (`.letter-body
strong`) is untouched.

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

**When not to reach for `.tradeoff`.** The annotation exists for a
real architectural fork — CRDT vs. Raft, consistency vs. availability,
build vs. buy — stated in one concise clause. It is not a device for
making a thin bullet look substantive, and it is not free: every word
in it is a word the reader has to process before the bullet ends.
Don't add one because:

- the bullet has no hard metric. Fix that by finding the number or
  rewriting the bullet, not by attaching a trade-off instead.
- it's ordinary implementation detail with no real alternative that
  was seriously on the table. "Used Postgres because that's what the
  team already ran" is not a trade-off; it's a fact, and it belongs
  in prose if it belongs at all.
- it would push the bullet past the length budget. A `.tradeoff` may
  **not** turn a 1-2-line bullet into a 3+-line paragraph. If the
  genuine trade-off can't be said in one short clause, either the
  bullet's main sentence needs to shrink to make room, or the
  trade-off doesn't belong on this bullet.

When the trade-off is ordinary and the bullet is otherwise
self-contained, prefer folding it into the main sentence as a plain
clause ("replaced the prior consistent-hash scheme after it
misbalanced under tenant skew") over reaching for the annotation.
Reserve the annotation for the case where the decision is the whole
point and stating it separately, in its own clause, is clearer than
burying it in the sentence.

**Length budget: one number, for every bullet, renderer-verified.**
§5.3's "1.0–2.0 wrapped lines" and this section's annotation budget
used to be two different rules stated in two different units (lines
vs. characters), with the annotated-bullet character cap set high
enough (290) that a compliant bullet could actually run 3+ lines. It
was never renderer-checked, so the gap went unnoticed until
`build/bullet-length-check.html` rendered it: at Letter, default
density — the tightest of the four supported render configs — a
bullet needs to stay at or under **~195–206 visible characters**
(main sentence + label + annotation, all of it) to hold 2 wrapped
lines, depending on word mix; compact density and A4 are each a
little more forgiving. The shipped `resume.html` sample's own
"legitimate" annotated bullets at 269, 228, and 211 characters were,
it turns out, silently rendering at 3 lines — the number that
licensed them was simply wrong. It's since been rewritten to comply.

**The budget is now one number, with margin under that measured
floor: 180 visible characters, for every bullet, annotated or not.**
No separate, larger allowance for an annotated bullet — the annotation
counts toward the same 2-line cap the plain-bullet rule in §5.3
already states, not a bigger one. A `.tradeoff` clause's own text
(excluding its label) additionally stays under **100 characters**, so
an annotation reads as a subordinate clause and can't consume the
whole budget by itself.

Two things enforce this, and they must be read together:

- `build/annotation-budget-test.js` — fast, static, no browser. Checks
  every bullet in the shipped documents against the 180-character
  total and the 100-character `.tradeoff` sub-budget, and that a
  bullet carries at most one annotation total (`.scope` + `.tradeoff`
  combined) and at most one `.tradeoff`. This is the gate the agent
  pipeline runs (`SKILL.md §The pipeline`). It takes file paths and
  defaults to the shipped samples, so the pipeline must pass the
  **filled** documents — called bare, it re-checks the two templates.
- `build/bullet-length-check.html` — the render truth the 180/100
  numbers above are calibrated against, and the regression that
  catches a future edit (a type-scale change, a margin change, a new
  density tier) quietly invalidating them. It renders worst-case
  filler text at exactly the budget, as a plain bullet, a
  `.scope`-annotated bullet, and a `.tradeoff`-annotated bullet, in
  the real `.page > .highlights > li` structure, across all four
  render configs (Letter/A4 × default/compact), and asserts each sets
  in ≤ 2 lines — plus a fifth fixture ~40 characters over budget that
  must *not* comply, proving the rig actually discriminates. Open it
  after touching type scale, margins, or the density tokens.

180 is not the render-measured ceiling — it's that ceiling (≈195 at
the tightest config) with ~15–25 characters of margin for word-mix
variance and engine differences between the render check and the
actual PDF pipeline. Do not raise it without re-running
`build/bullet-length-check.html` and confirming the new number still
holds at Letter, default density.

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
16–20 terms, and no `dd` over 64 characters** (measured one-line floor
70 [M], Letter/default — `build/line-yield-check.html`). Terms are the
authoring unit; the character budget is what `build/fit-estimate-test.js`
can actually enforce. The shipped `resume.html` sample is exactly that — 3
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
sample, 13 of the 16 — only Postgres, Kafka and Elasticsearch also
appear in a bullet).

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
- **One line. Budget 78 characters** (measured one-line floor 84 [M],
  Letter/default — `build/line-yield-check.html`; enforced by
  `build/fit-estimate-test.js`). An earlier "~70" here was asserted, not
  measured. Abbreviate the degree (`B.S.`, `M.S.`, `Ph.D.`) rather than
  the institution. `text-wrap: pretty` handles the rare unavoidable wrap.
- Certifications, coursework, bootcamps, honours, GPA, and graduation
  dates do **not** appear anywhere. "Highest completed degree" means
  completed; an in-progress degree is not rendered.
- **Known parse cost, accepted:** strictly section-segmenting ATS
  stacks map education from a *heading* and will file this line as part
  of the title instead. Full-text parsers find it wherever it sits, and
  application forms collect education separately — see §8.1.

---

## 6. Density rules

**One well-filled page is the default and only target shape**, for
every résumé this system generates, regardless of job title or
seniority. "Senior Staff," "Principal," "Director," "VP," "executive,"
or any similar title language is never, on its own, a reason to plan
for a second page — see `SKILL.md §The pipeline`, step 5, for the
exact measured workflow that gets there. A multi-page résumé is
produced only from an explicit host/user override for a specific
application; §6.1 below still documents how a résumé fragments across
pages when an override produces one, but that is support for the
override case, not a second default shape this system aims for.

| Length goal | What "fits" looks like |
|-------------|--------------------------|
| One page, 90–100% of the measured type area | The desired default outcome, at any seniority. As many of the candidate's roles as exist (typically 3–5), each with 3–6 bullets; a `Selected Systems` entry only where it carries evidence no bullet already states; a 3-row Skills block. |
| One page, under 90% | Acceptable only when there is nothing true and distinct left to add — see the pipeline's "under 90%" step. Never reach for filler, restated metrics, or adjectives to close the gap. |
| Multi-page | Produced only from an explicit host/user override for this application — never the default, and never inferred from title. Once requested, it uses the same measured `data-density="compact"` fallback and the fragmentation rules in §6.1 as any paginated document. |

Block sizes are not quoted here in pixels on purpose: they depend on
the renderer, the density variant, and whether the Google Fonts CDN
served the real families or a fallback. Measure the actual render if
you need a number, and state the renderer alongside it.

**Getting to one well-filled page is a content decision, not a type
decision.** Cut lower-value or redundant content first — a `Selected
Systems` entry that restates bullet metrics is the largest single
recovery and costs zero searchable terms (`SKILL.md`'s "Do not let
'Selected Systems' restate the bullets" is exactly what the shipped
`resume.html` sample now does); the skills block stays capped at 3 rows
regardless. Retain every documented role and at least one factual
bullet per role even under a large cut — losing a whole role is never
one of this system's fitting moves. Reaching for smaller type or
tighter margins as the *primary* path to one page is exactly what this
system avoids: `data-density="compact"` is the one measured-fit
fallback (§6.0), applied once, after a render has actually measured an
overflow — never pre-emptively, and never a substitute for cutting
content.

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
Salutation   ── "Dear [Name]," or "Dear [Company] Hiring Team,"
             when no named contact exists. No address block
             precedes it — see §11.2.1.
Body         ── 3–4 paragraphs, Source Serif 4. Specifics over
             adjectives, same as the bullets: a number per claim
             where one exists. The opening sentence leads with a
             job-specific thesis, an evidence-to-need connection, or
             a supported observation about the company's work — never
             an announcement of the application itself (§11.2.2).
             Read every sentence once as a new recruiter: prefer
             literal first-read language and name the concrete actor,
             artifact, and action when an interface or ownership claim
             would otherwise require interpretation (§11.2.3).
             <strong> (SemiBold, never 700) on only the one or two
             headline figures.
Close        ── valediction + signature (the name, nothing else),
             wrapped in .letter-close.
```

### 11.2.1 No recipient address block — by design

Earlier drafts rendered a postal-style address block (addressee /
company / role) between the date and the salutation. Removed, for
modern tech-industry applications specifically:

- **Redundant with the salutation.** Most postings name no contact,
  so the block's addressee line reads "Hiring Team" — the same two
  words the company-specific salutation repeats one line below.
  Stacking them is not formality, it's padding.
- **Redundant with what the submission already carries.** The ATS
  upload, the filename, and the job record already tell the reader
  which role and company this is; the salutation repeats the company
  name a second time when no named contact exists. A block above the
  fold restating the same two facts a third time is pure padding, not
  formality.
- **Off-register for this voice.** A postal address block answers a
  letter mailed to an unknown desk. This system's references — Stripe
  Press, Pentagram partner CVs, staffeng.com — open straight from
  letterhead to salutation; none carry one. A letter submitted through
  an ATS upload or an email attachment already arrives with its
  company and role context attached in the submission itself (§11.2.2)
  — the block has no job left to do.
- **Costs space a one-page letter can't spare** (§11.4).

**Named contact known:** put the name in the salutation only, never in a
standalone block. **No name known:** the salutation carries the company
instead of a bare generic hiring-team greeting; naming the company is the
whole reason that line exists.

### 11.2.2 The opening sentence (hard gate)

**The first sentence must immediately give the recruiter information
useful to them.** The recruiter already knows this is an application —
the ATS submission context, the filename, the job record, and the
company-specific salutation directly above the opening paragraph all
carry that information already. A first sentence that re-announces it
spends the reader's first six seconds on a fact they already have.

The opening sentence must begin with one of:

1. **A job-specific thesis** — a claim, stated up front, about what
   the candidate would do or bring to *this* role.
2. **A concrete evidence-to-employer-need connection** — a specific
   piece of the candidate's own experience laid directly against
   something the role or the company needs.
3. **A supported observation about the company's work** that
   establishes the candidate's relevant direction — a real, specific
   read on what the company is building, connected to where the
   candidate's own work has been pointed.

When that sentence first introduces an unfamiliar prior employer, it
must also identify the candidate's role or relationship there. A bare
organization-first opening is too abrupt because the recruiter has no reason
to recognize that organization.

**Never open by announcing the document's purpose or the act of
applying.** The following constructions, and anything equivalent, are
forbidden as an opening:

- "I am writing to apply…" / "I'm writing to apply…"
- "I am applying for…"
- "I am writing to express my interest…"
- "Please accept my application…"

**This is not a ban on naming the company or the role.** Both may
appear in the opening sentence — even in the first few words — when
they are grammatically load-bearing inside the thesis or the
evidence-to-need connection itself. What is forbidden is naming them
*only* to announce that a document about them follows. The test is
structural, not lexical: would the sentence survive with the company
and role name removed and replaced with almost any other company and
role, and still read as generic throat-clearing? If yes, it is an
announcement and must be rewritten. If the sentence falls apart
without the specific company and role in it, because the substance
depends on them, it passes.

**Frame the source of employer context accurately.** A statement about an
employer, team, product, or operational practice that comes only from the job
listing is the listing's description, not independently verified fact. Attribute
that description plainly; reserve an unqualified external assertion for reliable
research. The attribution should clarify provenance, not become repetitive
hedging. Discuss the target scope as *this role* or the work itself; do not use
impersonal source framing such as “the listing describes” for ordinary role
responsibilities. Use listing attribution only when it establishes the
provenance of an unverified employer or company assertion. A reporting verb
belongs to the source document, never to the target position or work being
described. Refer to the position attached to the application with a proximal
determiner unless the sentence explicitly contrasts it with another role.

Audit before shipping: grep the filled letter for the forbidden
openers before rendering, the same discipline as the dash gate:

```sh
grep -niE "writing to apply|writing to express my interest|^i am applying for|please accept my application" filled.html
```

Any hit means the opening needs a rewrite, not a synonym swap —
"I'm reaching out to apply…" trips the same failure with different
words.

### 11.2.3 Evidence synthesis, honest qualification, parallel construction, and earned generalization (hard gate)

Six failure modes show up together often enough in generated
letters that they get one gate. All six are about *how* true,
relevant evidence gets said, not about inventing or hiding evidence.

**Scope.** Rule 1 (volunteered weaknesses) and the closing
synthesis rule are cover-letter rules — the résumé has no prose in
which to commit them. Rules 2, 3, 4, and 5 (colon-led inventories,
overloaded sentences, reused metaphors, and broken parallel
construction) bind **every string the system writes**: the letter's
paragraphs, and equally the résumé's bullets, role summaries, and
project descriptions (§5.3). Rule 6 (earned generalization) binds
**every generated prose surface** in the part that can occur there:
its scope-inflation and bridge-noun clauses apply to any string that
draws a conclusion from evidence, including a résumé role summary or
project description; its paragraph-boundary antecedent clause applies
wherever one paragraph or sentence follows another and refers back —
in practice the cover letter, which is the only multi-paragraph prose
surface the system ships. They live here so they are stated once
rather than twice.

**Diagnose by shape, not by wording.** Each rule below is stated as
a sentence *pattern*, with schematic placeholders rather than sample
copy. That is deliberate: a memorable specimen sentence teaches a
generator to avoid that sentence, not that shape. Test a draft by
asking what structure it has, never by matching it against a phrase
list.

**1. Don't volunteer weaknesses.** "Honest" means not exaggerating.
It does not mean proactively disclosing what the candidate hasn't
done. Reject any sentence whose grammatical subject or main clause is
the boundary of the candidate's experience — patterns of the form
*"that work was [X], which is the limit of my experience against
[requirement]"*, *"I haven't worked with [technology] directly,
but…"*, *"while I lack [X]…"* — however the words are chosen. Any
clause that exists to name what is missing is the failure; a synonym
for "limit" is still the failure.

When the candidate has adjacent experience, the repair is to make the
transferable understanding the subject of the sentence: state
concretely what the adjacent work required them to get right, and let
the reader draw the connection to the target requirement. Claim the
understanding, not the equivalence. Only name a gap when the
application explicitly requires disclosing it, or when omitting it
would be materially misleading about a hard requirement.

**2. Don't lead evidence with a colon and a list.** The rejected
shape is *[framing clause] : [item], [item], [item], and [item]* — a
colon whose right-hand side is three or more parallel phrases naming
systems, technologies, or accomplishments. It reads as an inventory
pasted from a résumé rather than an argument, and the parallel
phrasing means no relationship between the items is ever stated.

The evidence in such a sentence is usually fine; the shape is the
defect. Repair by writing the same facts as sentences whose verbs
carry the relationships — what fed what, what one component made
possible for the next, who owned which part — and by dropping the
items that were only there for coverage. A colon introducing one
genuine explanatory clause remains a valid dash repair (§5.3.1); the
rule is about the enumerated right-hand side, not the colon.

**3. Don't overload a sentence.** Reject any sentence that combines
several of these at once — two or more independent systems, a
subordinate qualification, a concessive clause, and a conclusion
drawn from all of them. The symptom is a sentence a reader must hold
in memory to finish. Split it so each sentence makes one principal point and the
next explains its relevance, in causal sequence. Concrete and short
beats comprehensive and nested.

**4. Don't reach for a metaphor and reuse it as connective tissue.**
Figurative language for integration boundaries, ownership, or data
flow — typically a structural or joinery image — is rarely
load-bearing, and the same figure repeated across paragraphs to
stitch the letter together reads as a tic, not a voice. The
diagnostic is repetition and function: if a figure appears more than
once, or is carrying a paragraph transition rather than clarifying a
specific claim, replace it with the literal description — what system
talks to what, who owned which boundary, where the data came from and
where it went. A figure of speech is allowed only where it does real
work inside one sentence.

**Read literally on the first pass.** Reject idiom, figurative personification,
or an implied actor, artifact, or action when a recruiter must translate the
sentence or reconstruct what it literally means. This matters especially for
interface and ownership claims: name the concrete actor, artifact, and action
rather than implying that an interface acts on its own or that responsibility
belongs to an undefined surface. Literal language may still be concise; the
test is whether a new reader can identify what did what to which thing without
supplying missing context.

**Read word boundaries literally too.** A sentence can be grammatical under its
intended parse yet still send a new reader down the wrong path when adjacent
words form a familiar compound or phrase across a clause boundary. Test the
first read, not just the eventual grammar: if the reader could initially take
the adjoining words as a different unit, recast the verb or clause. Do not use
a comma to force a subject–verb break. For example, where a noun ending in
“tool” is followed by a verb phrase beginning “calls for,” choose a verb such
as “requires” so the reader never first sees the unrelated compound “tool
calls.”

**Give each technology its actual operation.** A technology name earns its
place only when the governing verb accurately describes what it did in the
system. Do not group components with distinct roles under one operation merely
because they were deployed together. A container orchestrator can coordinate or
define containers; a web server can serve or proxy; an application server can
run the application. Describe those operations separately rather than saying a
web server or application server “containerized” a service.

**Delete category restatements.** A bridge sentence must add a decision,
mechanism, constraint, result, or relation to the argument. A sentence that
only restates its own category — for example, “For tools that remained
in-house, I built software” — supplies no evidence or transition. Rewrite it
with the distinction that matters, or delete it.

**5. Keep coordinated elements grammatically parallel.** Coordination
signals — `from X through/to Y`, `both X and Y`, `either X or Y`,
`not only X but also Y`, and any list construction — promise the
reader that the elements on either side of the signal are the same
kind of thing. Reject any instance where they aren't: a noun phrase
paired with a gerund phrase, an infinitive paired with a finite
clause, an action paired with a thing. The most common offender is
the process span *from [noun phrase] through [verb-ing phrase]*, which
changes grammatical form between its endpoints without announcing it.

Repair by putting every coordinated element in the same form — noun
phrase with noun phrase, action with action — and prefer whichever
repair changes the fewest words. Padding the seam instead of fixing the
mismatch is not a repair; it only buries the grammatical change in
bureaucratic filler. This
rule applies everywhere Rules 2–4 apply: cover-letter paragraphs and
résumé bullets, role summaries, and project descriptions alike.

**6. Earn the generalization, and name what it generalizes.** A
concluding or transitional sentence may generalize from the evidence
above it **only when it explicitly names the concrete thing that
connects that evidence** — the responsibility, the system, the
decision, the process, or the mechanism. A sentence that draws a
conclusion without naming what it is a conclusion *about* is detached
synthesis: it sounds like an argument and carries none. Three
symptoms, which usually arrive together.

*Scope inflation.* Reject any sentence that widens one example or one
role into a broader claim the source does not support. One example
supports a claim about that example; one role supports a claim about
that role. Career-wide breadth, including claims about a general
working style, requires source evidence that is itself career-wide.

*Undefined bridge nouns.* Abstract nouns whose job is to stand in for
the relationship being summarized — "shape", "pattern", "approach",
"theme", "throughline" — are permitted only when the same sentence
immediately defines the concrete actions or relationship they
summarize. A bridge noun that merely gestures at endpoints names no
relationship and leaves the reader to supply the connection. Naming
the sequence, ownership, or hand-off is what turns it into a claim.

*Ambiguous backward reference at a paragraph boundary.* A paragraph
that opens with "this", "that", or "it" pointing back at the previous
paragraph must have **exactly one** plausible antecedent. When the
previous paragraph offered several — an evaluation, an integration, a
decision, and an abstract summary noun — the pronoun silently picks
none of them, and the transition the sentence was supposed to make
does not happen. Repeat the precise noun phrase instead, even at the cost of a
few words. The same test applies inside a paragraph whenever more than
one candidate antecedent precedes the reference.

**Repair** a detached synthesis one of two ways, and no third way:

- **Rewrite it as a concrete, evidence-scoped conclusion** — name the
  responsibility or mechanism, and keep the breadth inside what the
  evidence supports.
- **Delete it.** A synthesis sentence that adds no supported reasoning
  is not load-bearing, and the paragraph it sits in is stronger for
  losing it.

**Filler is not a repair.** "That said", "Additionally", "In this
way", "With that in mind", and any other connective phrase that names
nothing leaves the antecedent just as ambiguous and costs a line —
exactly the non-repair that padding a coordination seam is under Rule
5. A transition earns its place by naming the thing it carries
forward.

**Write from the evidence, not from its phrasing.** Preserve every fact and
its scope, but vary distinctive source constructions across the résumé and
letter. “Built from scratch” is rarely load-bearing; use a natural supported
verb such as “designed and implemented,” “created,” “developed,” or “delivered”
when it carries the same meaning. Establish the argumentative relationship
before introducing a new employer, project, or period. Temporal contrast words
such as “now,” “still,” “again,” “before,” and “after” require an explicit
contrast or sequence already on the page. Prefer common contemporary diction:
close or address a gap, never “answer” one. Name an ordinary prior employer
once, then use the role, system, project, organization, or “there” when the
referent is clear. Narrow connective or causal language directly entailed by
the evidence is welcome because it improves flow; a new candidate fact,
outcome, scope, tool, sequence, or motivation is not.

**Synthesize, don't list.** The letter's job is to explain what the
candidate built or owned, the problem it solved, and why that matters
to *this* role — as a small number of well-chosen examples argued in
prose, not a converted résumé-bullet list trying to mention every
related system. Pick the strongest one or two pieces of evidence per
paragraph and develop them; a paragraph that name-checks five systems
to be thorough is weaker than one that explains one system well.

**Close by connecting contribution to work.** When the final paragraph invites
a conversation, its final sentence should connect the candidate's relevant
contribution to the target work. A sentence that ends only on what the candidate
wants to learn, hear, or discuss leaves the argument pointed inward; revise it
so the invitation carries the role-facing contribution forward. Keep the
invitation direct and present-tense without relying on conditional or deferential
boilerplate: “I welcome a conversation” is direct; “I would welcome a
conversation” or “I would welcome a discussion” is not.

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
- **The opening sentence is a hard gate, not a style preference.**
  §11.2.2 sets the rule and the audit grep: lead with a job-specific
  thesis, an evidence-to-need connection, or a supported observation
  about the company's work, never with an announcement that this is
  an application.
- No icons, no colour blocks, no second accent, no closing P.S. The
  typographic vocabulary is the résumé's: `·`, `–` (ranges only), `→`.
- **No dash connects clauses in the letter's sentences.** Long-form
  prose is where em dashes creep in hardest, and where they read most
  strongly as machine-written. §5.3.1 applies to every sentence here;
  the repair is a comma, a conjunction, or two sentences.
- **Evidence is synthesized, not listed, and no weakness is
  volunteered.** §11.2.3 is the hard gate: no colon-led inventories,
  no overloaded multi-clause sentences, no recycled metaphor as
  connective tissue, no coordinated construction (`from X through Y`,
  `both`/`either`/`not only` pairs, lists) whose two sides shift
  grammatical form, and no sentence whose job is to announce what
  the candidate hasn't done.
- **Every conclusion stays inside the evidence that earned it, and
  every paragraph transition names what it carries forward.** One
  example or one role never becomes "most of my work" or "throughout
  my career"; a summary noun ("shape", "pattern", "approach") defines
  the concrete responsibility or sequence it stands for in the same
  sentence; and a paragraph opening on "this", "that", or "it" has
  exactly one possible antecedent, or repeats the noun phrase instead
  (§11.2.3 Rule 6).
- **Name cross-domain work through the concrete artifact or responsibility.**
  A bare possessive industry label can imply operational work or broader
  industry tenure than the evidence supports. Name both the supported domain
  and the actual function of the work.
- **Name every data-flow actor.** Avoid ambiguous plural references such as
  "data they used" or "through their APIs" when several systems or vendors
  are in view. State who produced, consumed, or exposed the data. In the close,
  say what experience, skills, or work the candidate would bring; those
  capabilities are not themselves "the evidence" brought to a role.

### 11.5 Short letters stay top-aligned

The cover letter always begins at the same top position as the résumé.
Short content leaves its unused space below the close; it is never vertically
centred or shifted down to balance the page. This shared top edge makes the two
documents read as a matched pair and keeps the letterhead position stable
across every generation, paper size, and density.

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

### 11.7 Letter type tokens — and the compact contract

The letter's type comes from tokens, never literals:
`--fs-letter-body` (10.5pt) with `--lh-letter` (1.6) for the body and
the valediction, and `--fs-signature` (15pt / 1.1) for the signature.

Why that matters more here than anywhere else: those values *are* the
letter's dominant vertical space. While they were hardcoded in
`cover-letter.css`, `data-density="compact"` — a combination this system
documents as supported on both surfaces — did essentially nothing to a
long letter, yet still shortened the letter's optical tail trim from
1pt to 0.4pt. The letter paid compact's cost and collected none of its
benefit, and the untrimmed slack (~0.6–1.2pt) sat above the system's own
0.5pt perceptibility tolerance (§4.4).

The contract:

- Compact moves the letter body with the résumé's: 10.5 → 10pt, leading
  1.6 → 1.5.
- Compact does **not** move `--fs-signature`, for the same reason it
  does not move `--fs-display`: shrinking an identity mark to claw back
  lines is the wrong trade.
- Because the closing line's metrics therefore never change,
  `cover-letter.css` pins `--optical-tail-trim` back to 1pt in *both*
  densities. The override is a `:root, :root[data-density="compact"]`
  pair in that file — equal specificity to the compact block in
  `colors_and_type.css`, winning on load order, and structurally scoped
  to the letter because the résumé never loads the file.

Never hardcode a pt value on `.letter-body`, `.valediction` or
`.signature`. A literal there re-breaks the density contract silently:
the letter still looks right at default density, which is the only
state anyone inspects.

---

## 12. What this template is *not*

- Not a creative CV. Not a portfolio site.
- Not driven by colour, illustration, or graphic devices.
- Not optimised for screen reading at desktop sizes — it is optimised
  for an 8.5×11 PDF that a recruiter scrolls through.
- Not a place to express personality through layout. Personality
  lives in the bullets.

When in doubt: do less, and do it more carefully.
