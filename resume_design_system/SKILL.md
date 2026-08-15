---
name: editorial-resume-design
description: Use this skill to generate editorial-modernist, developer-literate résumés for staff/principal-level engineers and adjacent senior individual contributors. Input is structured candidate data (plaintext / markdown experience, projects, skills, education, contact info) plus a target company / job description. Output is a print-ready PDF tuned to the recipient.
---

# Editorial Résumé Design System

A polished, opinionated visual template for senior IC résumés. The
system is **agent-only**: there is no human-facing UI, no manual
build step, no interactive editor. An agent reads candidate data +
a job description, fills the HTML template, generates the PDF, and
post-processes it into the right print variant for the recipient.

## Files in this skill

| Path                          | Role                                                                                |
|-------------------------------|-------------------------------------------------------------------------------------|
| `STYLE.md`                    | The full design specification. **Read this first.** Every rule, with rationale.    |
| `README.md`                   | Philosophy, content rules, system caveats, anti-patterns.                          |
| `colors_and_type.css`         | Design tokens — colour, typography, spacing, page geometry, all variants.          |
| `resume.css`                  | Components — page chrome, header, sections, roles, bullets, projects, skills, education. |
| `resume.html`                 | The template + a fully-populated realistic sample. Adapt this per candidate.       |
| `build/dual-mode-pdf.js`      | Pure module exporting `addOcgBackground(bytes) → bytes`. UMD; loads in Node or browser. |
| `build/vendor/` (removed)     | pdf-lib 1.17.1 now loads from CDN (browser) / the `pdf-lib` npm package (Node) — no longer vendored. |
| `fonts/` (removed)            | Source Serif 4, Inter, IBM Plex Mono now load from the Google Fonts CDN — no longer bundled. |
| `preview/`                    | Standalone preview cards for each design subsystem. Reference material only.       |

## The pipeline

End-to-end, given candidate data + job description:

1. **Parse candidate data.** Extract: name, contact (email, location,
   one optional URL — site OR github, not both), 3–6 role entries
   with titles + companies + dates + 3–6 bullets each, optional
   "Selected Systems" / "Projects", a skills block, and education.
   Apply the content rules in `STYLE.md §5` aggressively — kill
   adjectives without numbers, demand a scale number or trade-off
   in every bullet.

2. **Read the job description.** Identify:
   - Company name and the *kind* of company (see decision table below)
   - Role level (staff, principal, senior, IC4+) — confirms the
     system is being used in its target band
   - Any explicit format requirements (one-page, A4, B&W, etc.)

3. **Choose variants** by company / industry signal. The full
   decision rule is `## Variant selection` below — read it before
   filling the template. The chosen variants become attributes on
   `<main class="page">`.

4. **Fill `resume.html`** with candidate content following the
   structural conventions in `STYLE.md §4–§7`. Preserve the existing
   semantic markup; do not invent new component shapes. Use the
   `.scope` cell for role ownership, `.tradeoff` for trade-off
   annotations on staff-level bullets, `<strong>` for scale numbers
   inside bullets.

5. **Generate the source PDF.** From the filled HTML, render to
   PDF via Puppeteer / Playwright / equivalent. Required flags:
   `printBackground: true`, `preferCSSPageSize: true`. The system
   defines CSS named pages (`letter`, `a4`), so the PDF size matches
   automatically when `data-page="a4"` is set.

   **Page-count handling — the compact-density algorithm.** After
   the first render, count the pages in the produced PDF:

   - **Page count == target.** Ship as-is. Don't apply
     `data-density="compact"`.
   - **Page count > target AND overflow looks small** (~1–9 lines,
     or the final page is < 30% full): set
     `data-density="compact"` on `<html>` and re-render once. This
     reclaims 6–9 lines per page and usually fits the content.
   - **Page count > target AND overflow is large** (final page >
     30% full, or > 9 lines): the *content* is too long. Cut
     bullets per the rules in `STYLE.md §5` before re-rendering.
     Compact density alone won't save it, and applying it to a
     content-bloated résumé just compresses bad material.

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

The system ships five variants. They compose freely *except* the
two `data-print="…"` values, which are mutually exclusive. Defaults
are calibrated for the system's home territory (senior engineering
at design-conscious tech companies). For other recipients, override.

**Canonical placement.** Set `data-print="…"` on `<html>`, not on
`<main class="page">`. The CSS supports both for backward
compatibility, but `<html>` is the cleaner mental model: "this
whole document is rendered in dual-pdf / ink-only mode." Other
variants (`data-page`, `data-mono`, `data-density`) also work on
`<html>`.

### Step 1 — Classify the recipient

Work from the named-company list first. If the company name is
not listed, fall through to the prose-style heuristics below.
If still unclassifiable, take the named fallback. **Never agonise**
— the wrong call here is recoverable; the right call here is not
worth more than 30 seconds of inference.

**Per-company decision rule:**

| Recipient profile                                                                          | Variants                                                       |
|--------------------------------------------------------------------------------------------|----------------------------------------------------------------|
| Design-conscious tech / startup (Anthropic, Stripe, Linear, Figma, Vercel, Notion, Vercel, Render, Modal, Replicate, Cursor, Anduril, infra startups, design-led seed/Series-A) | `data-print="dual-pdf"` *(default)*                            |
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

- `data-page="a4"` — pair with any of the above when shipping to
  non-US recipients. Recomputes margins for A4 stock and routes
  the print to the `@page a4` rule.
- `data-density="compact"` — apply *only after* a first render
  shows overflow. See §Pipeline step 5 for the operational rule.
  Do **not** apply pre-emptively — the default density is
  calibrated for readability at this fidelity.

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
- **Or one trade-off annotation** (italic, prefixed with " ·
  trade-off:"). At most one per bullet; staff-level differentiator.
- **No bare adjectives.** "Optimised", "improved", "led" without
  measured outcomes are wasted lines. Cut them.
- **1.0–2.0 wrapped lines per bullet.** Three-line bullets read
  as paragraphs and break the rhythm of the section.
- **3–6 bullets per role.** Fewer reads thin; more reads as a list.

Verbs to prefer: *designed, shipped, owned, drove, killed, replaced,
rewrote, migrated, decommissioned, halved, tripled, tenfold-d*.
Verbs to avoid: *worked on, helped, participated in, assisted with,
contributed to* — they describe presence, not authorship.

The bullet vocabulary should read like distilled system-design
interview answers: **Problem → Solution → Measurement → Trade-off.**
That four-beat structure is what the template's typography is built
to display.

## Negative space — what the system does NOT do

- No icons, no skill bars, no progress dots, no photos
- No coloured ranges, no gradients, no rounded cards
- No emoji
- No two-column layouts (the date cell is right-aligned within
  the same flex row — it is not a parsed second column)
- No "summary" or "objective" paragraph at the top
- No tagline under the name beyond a single role descriptor
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
