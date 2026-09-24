# ENGINEERING.md — build, packaging and provenance

Developer material for the design system: where files live, how the PDF
is produced, what is tested and by what, and how the folder should be
packaged.

**This file is deliberately outside the editorial rubric.** `SKILL.md`
and `readme.md` are read *whole* into every résumé and cover-letter
generation prompt, so anything in them is paid for on every request and
acted on as if it were an editorial rule. Build mechanics are neither.
Keep developer prose here; keep `readme.md` to *why the writing is the
way it is*.

---

## Sources & provenance

This system was designed from a written brief, not from an existing
codebase or brand. There are no Figma files, no GitHub repos, no
attached design assets. The references named in the brief are
**spiritual references**, not licensed source material:

- Stripe Press book interiors (Stripe — printed books)
- staffeng.com and lethain.com (Will Larson — public blogs)
- Pentagram partner CVs (public examples online)
- modern-cv on Typst Universe (open template — typographic reference only)
- Matthew Butterick, *Practical Typography* (practicaltypography.com)

All three families load from the **Google Fonts CDN** (CSS2 API), pinned
to exactly the weights the system uses:

- `Source Serif 4` — 400, 600
- `Inter` — 400, 500, 600 *(no Bold by design)*
- `IBM Plex Mono` — 400, 500

Loaded via a single `@import` at the top of `colors_and_type.css`. **Not
self-contained**: typography has a render-time dependency on the CDN.
Ensure it is reachable from the render environment, or re-vendor the
families locally for an air-gapped build. Swap families by editing the
`--ff-*` tokens; the system is family-agnostic.

**Hidden coupling worth knowing:** a host that inlines this CSS may
rewrite that `@import` (a Google-Fonts import regex plus font-readiness
gating before print is the pattern used by the Electron host). If PDFs
come back with Type3 fonts or missing glyphs, look at the host's rewrite
and its font-ready gate before suspecting this stylesheet.

---

## Index of files

Everything in the folder, current as of this audit pass.

### Design surfaces (read at generation time)

| Path | What it is |
|------|------------|
| `STYLE.md` | Every design decision, fully documented. **Read first.** |
| `SKILL.md` | Agent prompt — pipeline + per-company variant selection. |
| `readme.md` | Philosophy, content rules, caveats (the *why*). |
| `styles.css` | Public entry point for consumers — re-exports the token closure via one `@import`. The two shipped documents link `colors_and_type.css` + their own component sheet directly, so this file is a convenience for consumers, not a build step. |
| `colors_and_type.css` | Design tokens — colour, typography, spacing, page geometry, all variants. |
| `resume.css` | Page chrome, paged-media model, header, sections, roles, bullets, projects, skills. Also carries the cross-document layer (page geometry, `@page`, letterhead, `.sep`) that the letter reuses — see "Known debt". |
| `cover-letter.css` | The letter surface — serif body, date / salutation / close, no recipient block. Load after `resume.css`. |
| `resume.html` | Résumé template + fully-populated sample. Adapt per candidate. |
| `cover-letter.html` | Paired cover-letter template + sample. |

### Runtime module

| Path | What it is |
|------|------------|
| `build/dual-mode-pdf.js` | **Shipped runtime code, not a build script.** UMD module exporting `addOcgBackground(bytes) → bytes`; the host loads it after rendering. It lives in `build/` for historical reasons and because the host's path to it is hardcoded — moving it means updating the host in the same commit. |
| `build/css-tokens.js` | Reads token values out of `colors_and_type.css` so tests and call sites never hand-copy a literal. |
| `build/harness.js` | The assertion harness every Node suite shares (was copy-pasted four times). |

### Automated suites — `cd build && npm test`

Run in this order by the `test` script:

| Suite | Guards |
|-------|--------|
| `test.js` | `dual-mode-pdf.js`: OCG structure, `/PrintState /OFF`, per-page marked content, `/D/AS` Print auto-state, idempotency, custom cream, rotation rejection, `/OCProperties` merges. Needs `npm i pdf-lib@1.17.1`. |
| `token-sync-test.js` | Every place a token value is restated as a literal: the module's cream default, the four `@page` running footers (ink, family, tracking), the four `@page` margin pairs, STYLE.md §3.1's colour table, the reference cards / thumbnail marks, and the generated bundle's source hashes. |
| `annotation-typography-test.js` | `.scope` / `.tradeoff` / `.annotation-label` inherit the owning bullet's type; no italic; docs don't re-teach the old treatment. |
| `education-placement-test.js` | No Education section anywhere; the degree rides in the header subtitle. |
| `ats-parse-test.js` | STYLE.md §8.1 parse hazards, in the documents *and* every stylesheet they link. Takes file paths; defaults to the shipped samples. |
| `annotation-budget-test.js` | One annotation per bullet, 180/100-character budgets, plus a checker self-test. Takes file paths; defaults to the shipped samples. |
| `page-policy-doc-test.js` | The one-page default and its explicit-override language. |
| `parallelism-gate-doc-test.js` | §11.2.3 Rule 5 (parallel construction) survives in all three docs. |
| `synthesis-scope-gate-doc-test.js` | §11.2.3 Rule 6 (earned generalization) survives in all three docs. |
| `bullet-redundancy-gate-doc-test.js` | The one-accomplishment-one-bullet rule (STYLE.md §5.3, SKILL.md "Do not let one bullet restate another" + its negative-space line, readme.md "Bullet ordering") survives in all three docs. |
| `fixture-safety-test.js` | Handoff/upload HTML fixtures use the documented synthetic identity and inert sync capability; no production-looking bearer token or live endpoint can be committed there. |

### Browser checks — `build/MANUAL-CHECKS.md`

`build/*-check.html` (seven files) plus
`handoff/pagination-contract-check.js` are unwired reference fixtures; they
need a real layout engine and the `-check` suffix is deliberate. The live host
pagination implementation is separately covered by the wired real-Chromium
regression in `scripts/electron-smoke.js` (`npm run test:e2e`), including a
deterministic six-page column-advance case. See that file for what remains a
manual check and when to run it.

### Reference material

| Path | What it is |
|------|------------|
| `preview/*.html` | Design-system reference cards (type, colour, spacing, components, variants, anti-patterns). Rendered as the design-system card grid; not used at generation time. Cards read live tokens — never hardcode a token value in one. |
| `preview/variant-contract-check.html` | Not a card: a manual regression sheet for the root-only variant contract, with an expectation table. |
| `handoff/` | Frozen implementation reference for the integrated paginated screen preview: `README.md` (the contract), `Application-paginated-example.html` (a sanitized generated snapshot), `pagination-contract-check.js` (narrow Playwright suite, not wired). The host implementation itself has wired Chromium coverage in `scripts/electron-smoke.js`; no shipped code reads this folder. |
| `assets/`, `uploads/` | Design references, screenshots, and sanitized sample inputs. Inputs, not runtime. Never retain a real candidate résumé, contact details, or live application-sync capability here. |

---

## PDF generation — the pipeline

The default in `resume.html` is `data-print="dual-pdf"`. The
agent-facing pipeline (parse data → classify recipient → fill template →
gates → render → post-process → emit) is **`SKILL.md §The pipeline`** —
that is the canonical reference. Mechanics in one paragraph:

Render the filled HTML to PDF with headless Chrome (`printBackground:
true`, `preferCSSPageSize: true`). If the active variant is `dual-pdf`,
pass the raw bytes through `addOcgBackground()` from
`build/dual-mode-pdf.js` to add the view-only OCG cream layer (PDF spec
§8.11). If the variant is `ink-only` (or any other), skip the
post-process — the PDF is already final. Emit as `<First-Last>.pdf`; the
dual-mode mechanism is invisible to recipients by design.

Prefer passing the colour in at the call site —
`addOcgBackground(bytes, { cream: <the --bg token> })` — so the CSS stays
authoritative. `build/token-sync-test.js` fails if the module's default
drifts from `--bg` regardless.

The module is UMD: same file in Node (`require`) and in
browser/Puppeteer contexts (script tag → `window.DualModePdf`). pdf-lib
1.17.1 comes from CDN in the browser
(`https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js`) and
from the `pdf-lib` npm package in Node. Self-test: `node build/test.js`;
browser path: open `build/browser-check.html`.

Pages 2+ print a mono page indicator (`2 / 3`) from `@page` margin
boxes; page 1 is suppressed so a one-pager never shows a counter
(`STYLE.md §10.6`).

---

## Packaging

If the host copies this folder into a shipped app (`extraResources` or
equivalent), copy the **runtime read set**, not the tree. At generation
time the app reads:

```
SKILL.md  readme.md  STYLE.md
colors_and_type.css  resume.css  cover-letter.css
resume.html  cover-letter.html
build/dual-mode-pdf.js
```

Everything else — `preview/`, `handoff/`, `build/` tests and fixtures,
`assets/`, `uploads/` — is authoring material. Shipping the whole folder
carries roughly an order of magnitude more bytes than the app opens,
including sample PDFs and reference PNGs.

---

## Known debt (deliberate, with reasons)

- **No shared document CSS layer.** `resume.css` mixes the
  cross-document foundation (page geometry, `@page`, letterhead,
  `.sep`, the trailing-edge trims) with résumé-only components, and
  `cover-letter.html` therefore loads ~570 lines to match about half.
  The clean split is a `document.css` layer that both surfaces load,
  with `styles.css` as its entry. It is not done here because the host
  inlines this system's stylesheets **by name**: adding a file changes
  the host's read set, so the split has to land in the same commit as
  the host change.
- **`build/` holds three kinds of thing** — one shipped runtime module,
  the Node suites, the browser fixtures — and builds nothing. Same
  reason: the host hardcodes `build/dual-mode-pdf.js`.
- **The dash-punctuation table is duplicated across `STYLE.md`,
  `SKILL.md` and `readme.md` on purpose.** Each of those files is read
  independently by a different consumer, and two doc gates assert the
  language is present in all three. Do not de-duplicate it.
