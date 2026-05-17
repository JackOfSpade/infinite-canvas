---
name: editorial-resume-design
description: Use this skill to generate editorial-modernist, developer-literate résumés for staff/principal-level engineering candidates. Single-file HTML with CSS design tokens, semantic markup that maps 1:1 onto JSON Resume v1.0.0 (plus x_scope / x_tradeoff / x_ai_assisted extensions), and a print stylesheet that renders to a clean vector-text PDF. Aesthetic: Stripe Press × Pentagram CV × staffeng.com. Quiet typographic confidence, one restrained accent, no icons, no skill bars.
user-invocable: true
---

# Editorial Resume Design

Read `README.md` for the full philosophy and visual foundations.
Read `STYLE.md` before touching `resume.html` or `colors_and_type.css` —
it documents every decision (type scale, color tokens, spacing,
heading rules, density rules, page-break rules) and the JSON-Resume
schema mapping.

## What's in here

| File                  | Use                                                      |
|-----------------------|----------------------------------------------------------|
| `colors_and_type.css` | Design tokens — color, typography, spacing, page geom.   |
| `resume.html`         | The template + a fully-populated realistic sample.       |
| `STYLE.md`            | Every rule, written down. **Read this first.**           |
| `README.md`           | Context, content rules, visual foundations.              |
| `preview/`            | Small standalone preview cards for each subsystem.       |

## How to use

**If generating a résumé from JSON:** copy `resume.html` and
`colors_and_type.css`, then replace the markup inside `<main class="page">`
with content from the source JSON, following the mapping table in
`STYLE.md §9`. The JSON Resume v1.0.0 shape plus `x_scope`,
`x_tradeoff`, `x_ai_assisted`, `x_summary`, and `x_metrics` extensions
cover every block.

**If rendering to PDF:** open the HTML in Chrome/Chromium and use
"Save as PDF" with default scale 100% and "Background graphics" on.
Or `puppeteer.pdf({ printBackground: true, preferCSSPageSize: true })`.
Confirm the resulting PDF round-trips through `Ctrl+A → paste-into-text`
in reading order before shipping.

**If asked for an artifact in this style with no other guidance:**
ask what the candidate is (level, domain, target companies), then
generate a fresh résumé following the system. Do **not** improvise
visual changes — colour, type, layout, and iconography rules are
load-bearing in this aesthetic; the moment you add a skill bar or a
gradient, the artifact stops reading as editorial and starts reading
as a Canva template.

## Non-negotiables (summary — full list in STYLE.md)

- Vector-text PDF, never image-based.
- Single primary column; right-aligned date/location cell is **not**
  a true second column.
- Standard section names: Experience · Selected Systems · Skills · Education.
- Standard bullets (`•`, `–`, `*`). Never arrows or emoji.
- Date format `Mon YYYY` (or `YYYY`).
- Contact info in body text inside `<main>`, never document header/footer.
- One accent colour, used on the candidate name only.
- No icons. No skill bars. No progress dots. No photo. No cards. No shadows on the page.

## Substitution flags to surface to the user

- **All fonts ship locally** in `fonts/` (Source Serif 4, Inter, IBM
  Plex Mono). Zero network dependencies at render time — copy the
  folder into a container or serverless environment and it renders
  identically.
- **System covers one surface** (the résumé). Don't generalise the
  typographic restraint to apps, marketing, or decks — make a separate
  system for those.
