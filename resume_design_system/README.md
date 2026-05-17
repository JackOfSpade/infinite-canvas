# Editorial Resume Design System

A polished, opinionated visual template + documented design system for
generating staff/principal-level engineering résumés from structured
JSON. Aesthetic: editorial-modernist, developer-literate, quietly
confident. Stripe Press book interiors, Pentagram partner CVs, the
body of `staffeng.com` and `lethain.com` — that lineage.

The artifact has two jobs at once: **parse cleanly** in Greenhouse /
Ashby / Workday-class pipelines, and **signal high** in 6–10 seconds
of human skimming. Every decision in this system is in service of one
or both of those.

---

## Sources &amp; provenance

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

All three families ship locally in `fonts/`:

- `SourceSerif4-{Regular,Semibold}.ttf`
- `Inter-{Regular,Medium,SemiBold,Bold}.woff2`
- `IBMPlexMono-{Regular,Medium}.ttf`

Declared via `@font-face` at the top of `colors_and_type.css`. **No
Google Fonts CDN, no other network dependencies at render time** —
this folder is self-contained. All three embed cleanly in
Chrome-rendered PDFs and match the documented aesthetic. Swap families
by editing the `--ff-*` variables in `colors_and_type.css`; the system
is family-agnostic.

---

## Index of files

| Path                       | What it is                                            |
|----------------------------|-------------------------------------------------------|
| `README.md`                | This file — context, content rules, visual rules.     |
| `STYLE.md`                 | Every design decision, fully documented. **Read first** before editing the template. |
| `colors_and_type.css`      | Design tokens — color, typography, spacing, page.     |
| `resume.html`              | The template + a fully-populated sample (open this).  |
| `SKILL.md`                 | Cross-compatible with Claude Code agent skills.       |
| `preview/`                 | Design-system tab cards (type, color, spacing, components). |

There are no `ui_kits/`, `slides/`, or `fonts/` directories — fonts
load from Google Fonts CDN, and this system has only one surface
(the printable résumé). If you fork it into a renderer with offline
font requirements, drop `.woff2` files into `fonts/` and update the
`@import` in `colors_and_type.css` with `@font-face` rules.

---

## Content fundamentals

The voice of the artifact is **first-person implicit** — bullets
elide the subject ("Designed the sharding strategy…", not
"I designed the sharding strategy…"). This is universal résumé
convention and parses cleanly; switching to "I" or "you" breaks
both.

### Casing &amp; punctuation

- Section names are conventional and Title Cased: **Experience**,
  **Selected Systems**, **Skills**, **Education**. Never
  capitalised "EXPERIENCE" in the source — the small-caps look is
  applied via CSS `text-transform: uppercase`.
- Sentence case in bullets. Capitalise proper nouns, products,
  protocols, services (Kafka, Postgres, gRPC, V8).
- Oxford comma. Em-dash for ranges in prose (`380 ms → 18 ms`),
  en-dash for date ranges (`Mar 2022 – Present`).
- Numerals: digits for everything quantitative. **Always** include
  the unit (`38 ms`, not `38`). Use `tnum` (built into the CSS) so
  numbers align across rows.
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

## Visual foundations

### Colour

A near-monochrome warm palette. **One** accent colour exists
(oxblood `#7A1F2B`), used by default on the candidate's name only.
The artifact reads as ink on warm paper. The full token table is
in `STYLE.md`.

| Token       | Hex       | Used on                              |
|-------------|-----------|--------------------------------------|
| `--bg`      | `#F7F4ED` | Page ground — warm off-white.        |
| `--ink-1`   | `#1A1815` | Body text, role titles.              |
| `--ink-2`   | `#54504A` | Dates, locations, role summary, scope &amp; trade-off annotations. |
| `--ink-3`   | `#8C857A` | Captions; the most subdued metadata.  |
| `--ink-4`   | `#B6AFA2` | Separators, hairline rules.          |
| `--accent`  | `#7A1F2B` | Candidate name (only).               |

The background is **never** pure white. The body text is **never**
pure `#000`. Both choices warm the page subtly without anyone
noticing — which is the point.

### Typography

A three-family system. Full scale in `STYLE.md §2`.

- **Source Serif 4** — display only (candidate name).
- **Inter** — everything else: tagline, section headers, role
  titles, bullets, dates, locations. Local `.woff2` in `fonts/`.
- **IBM Plex Mono** — technologies, project metrics, inline
  code-like terms.

Body sits at **10.25 pt** / 1.45 line-height / 70-75 chars per
line. Section headers are **9 pt uppercase tracked 0.14 em** with a
hairline rule, never bold and never coloured. The candidate name is
**28 pt Source Serif 4 Semibold** in the accent — it is the loudest
moment in the document and the only typographic flourish.

### Spacing

4 pt baseline grid. Tokens `--s-1` (2 pt) through `--s-10` (40 pt).
Section breaks (`--s-9`, 32 pt) feel like editorial whitespace, not
absence; role-to-role spacing inside a section (`--s-8`, 24 pt) is
distinctly tighter so the section reads as one block.

### Backgrounds, imagery, illustration

**None.** No images, no illustrations, no patterns, no textures,
no watermarks, no gradients on the page itself. The only background
is the flat warm off-white. In screen preview the area *around* the
page is a soft warm gradient to suggest paper sitting on a desk;
the page itself stays flat.

### Animation

**None.** The artifact is a PDF. Hover states are not real here.
On the screen preview, links carry a 0.5 pt baseline underline at
10% ink that darkens to 32% on hover (`--ink-2`). That is the
entire interaction vocabulary.

### Hover, press, focus states

- **Links:** baseline underline only; no colour change.
- **Press:** nothing — there is no press state for a printed
  document.
- **Focus:** browser default outline; not customised. The artifact
  is not interactive content.

### Borders &amp; rules

A single rule treatment: **0.5 pt hairline at 10% ink** (`--bg-rule`).
Used only under section headers, where it fills the line after the
header word. No rules between roles. No rules under the header
block. No card borders, no boxes.

### Shadows

**None on the page.** A subtle outer shadow lifts the page off the
warm-gradient screen background in preview; this is preview chrome
and is `display:none` in `@media print`.

### Corner radii

**None.** Everything is square-edged. The page itself has 0 radius;
nothing on the page is enclosed in a card, so there is nothing to
round.

### Transparency &amp; blur

**Almost none.** Transparency is used only to define the rule
colour (`rgba(26,24,21,0.10)`) and the link underline. No
`backdrop-filter`, no frosted layers.

### Layout rules

- Single primary column for all text flow.
- Right-aligned date/location "column" is a grid cell sharing a
  baseline with the role title — not a true second column. This is
  load-bearing for Workday-class parsers (see `STYLE.md §5.1`).
- Page geometry is fixed: 8.5 × 11 in, 0.72 in top/bottom, 0.78 in
  side margins. Override with the `--margin-*` variables if A4 is
  required; pull `--page-w: 210mm; --page-h: 297mm` for A4.

### Cards

There are no cards. The bullets are not cards. The roles are not
cards. The projects are not cards. Treating any block as a card
("box with rounded corners and a shadow") is the wrong move for
this aesthetic and would be reverted on review.

---

## Iconography

There is none, by design.

- No icon font (Material Icons, Heroicons, Phosphor, Lucide, etc.)
  is imported.
- No SVG icons ship with the system.
- No emoji.
- The only glyphs the design uses are: `•` for bullets, `·` for
  inline separators, `–` for date ranges, `—` for em-dashes in
  prose, and `→` only inside bullet text when describing a state
  change (`380 ms → 18 ms`). Even `→` is bullet content, not
  decoration.

If a future variant absolutely needs a single visual mark — a
monogram, say — it must be rendered as text (a glyph in Source
Serif 4), not an icon. The lineage references (Stripe Press,
Pentagram CVs) all hold this line.

**Substitution flag:** if a future client requires icon-augmented
sections (e.g. a small mail glyph beside the email address),
recommend **Heroicons outline** (24 px, 1.5 px stroke) over CDN as
the closest match in stroke weight and reserve. Document the
addition in `STYLE.md` if you ship it.

---

## Caveats

- The body and display fonts are loaded over Google Fonts CDN.
  For offline PDF rendering pipelines, switch to local `@font-face`
  with `.woff2` files in a `fonts/` directory.
- The screen preview wraps the page in a warm gradient so the
  artifact reads as paper. The print stylesheet strips this. If
  you screenshot for a Figma or marketing context, screenshot at
  print scale (1:1) rather than the screen preview.
- This system covers exactly one surface — the résumé. There are
  no app or marketing UIs, no slide deck, no email templates.
  Adding any of those should be done in a *separate* design
  system; the typographic restraint here doesn't generalise
  trivially.
