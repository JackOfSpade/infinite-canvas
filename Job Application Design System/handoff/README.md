# Paginated screen preview — integrated implementation reference

> **Status: integrated; folder frozen as a reference.** The live
> implementation is in `electron/ipc/resumeHtml.js`; the app does not read
> this folder. `scripts/electron-smoke.js` exercises the generated workspace
> in real Chromium and includes a deterministic six-page regression for the
> column geometry. This folder's narrower `pagination-contract-check.js`
> remains unwired because `@playwright/test` is not a project dependency.
> Indexed in `../ENGINEERING.md`.

Working demo: `Application-paginated-example.html` in this folder (a sanitized
generated application snapshot). Open it directly — résumé tab shows an
unmistakable page-2 seam; switch to the cover-letter tab, resize the window,
edit text, or toggle `data-density="compact"` / `data-page="a4"` on `<html>` in
devtools and the guide recomputes.

## What the integrated host implementation changed

Everything lives in the block `buildResumeDocument()` injects —
"Injected chrome (electron/ipc/resumeHtml.js)" — same place as `.ic-toolbar`,
`.ic-preview-area`, etc. Nothing in `styles.css` / `resume.css` /
`cover-letter.css` / `colors_and_type.css` changed. Print output is defined
entirely by those files' `@page` rules and the `@media print` block already in
the injected chrome; this patch only *adds* two more `@media print` lines that
suppress the new screen-only elements — it never edits an existing rule.

## 1. CSS — replace one line

```css
/* was: .ic-preview-area .page { margin: 0 auto; } */
.ic-preview-area .page { margin: 0; }
.ic-page-stage { position: relative; width: fit-content; margin: 0 auto 24px; }
.ic-page-stage:last-child { margin-bottom: 0; }
.ic-page-guides { position: absolute; inset: 0; pointer-events: none; z-index: 1; }
.ic-page-seam { position: absolute; left: 0; right: 0; }
.ic-page-seam-fade-top, .ic-page-seam-fade-bot { position: absolute; left: 0; right: 0; height: 14px; }
.ic-page-seam-fade-top { top: 0; background: linear-gradient(to bottom, rgba(26,24,21,.10), transparent); }
.ic-page-seam-fade-bot { bottom: 0; background: linear-gradient(to top, rgba(26,24,21,.10), transparent); }
.ic-page-seam-line { position: absolute; left: 0; right: 0; height: 1px; background: rgba(26,24,21,.18); }
.ic-page-seam-line-dashed { position: static; height: 0; border-top: 1px dashed rgba(26,24,21,.30); }
.ic-page-folio { position: absolute; right: 6px; font: 8.5px/1.3 "IBM Plex Mono", "SF Mono", Menlo, Consolas, monospace; letter-spacing: -0.005em; color: #8C857A; white-space: nowrap; }
@media print {
  .ic-page-stage { display: contents; }
  .ic-page-guides { display: none !important; }
}
```

`.page`'s own screen/print rules in `resume.css` are untouched.

## 2. Markup — wrap each panel's `<main class="page">`

`buildResumeDocument()` emits, per document panel:

```html
<section data-ic-document-panel="resume"><main class="page">…</main></section>
```

Integrated shape:

```html
<section data-ic-document-panel="resume">
  <div class="ic-page-stage">
    <main class="page">…</main>
    <div class="ic-page-guides" aria-hidden="true" data-ic-page-guides></div>
  </div>
</section>
```

Same for the cover-letter panel. `.ic-page-stage` and `.ic-page-guides` are
pure chrome — they never appear inside `<main class="page">`, so nothing about
reading order, ATS parsing, or the `contenteditable`/autosave code (which
reads/writes `main.innerHTML`, never the stage) changes.

## 3. Script — one new block + two one-line hooks

The host appends the pagination engine (full source in the frozen HTML, function
`scheduleRecompute`/`renderGuides`/`computeBreaks`) as its own `<script>`
before `</body>`. It exposes `window.icPageGuidesRecompute()`.

Two hooks into the surrounding script make the guide recompute on every event
the brief calls out:

```js
// end of selectDocument(kind) — tab switch
    if (window.icPageGuidesRecompute) window.icPageGuidesRecompute();

// main's existing input listener — content edits
main.addEventListener('input', function () { scheduleSave(); markPdfStale('resume');
  if (window.icPageGuidesRecompute) window.icPageGuidesRecompute(); });

// coverMain's existing input listener — content edits
      markPdfStale('cover');
      if (window.icPageGuidesRecompute) window.icPageGuidesRecompute();
```

Resize, font-ready, and root-attribute changes (`data-page`, `data-density`,
`data-mono`, `data-print`, `data-letter`) are handled *inside* the new script
itself via `ResizeObserver` on each `.page`, `window.resize`,
`document.fonts.ready`, and a `MutationObserver` on `<html>`'s attributes — no
further hooks needed for those.

## How it works (visual rationale)

The rendered `.page` is still one continuous flowing box — nothing about the
document DOM changes. A **detached, off-screen clone** of `.page` is
temporarily laid out inside a CSS multi-column box whose column height equals
one printed page's usable content height (read live from `--page-h`,
`--margin-top`, `--margin-bot` — the same custom properties `data-page="a4"`
and `data-density="compact"` already override on `:root`, so the geometry the
guide reads is always whatever those variants currently say). Chromium's own
CSS Fragmentation engine — the same machinery that paginates `@page` content —
decides where that clone's bullets, roles, and paragraphs fall across
"columns," honoring every `break-inside: avoid` / `break-after: avoid` rule
already in `resume.css`. That gives page-break positions that track real
pagination, not a naive "every 11 inches" guess that could land mid-bullet.

The clone is `border-box` and retains the document's side padding, so its
usable CSS column is narrower than the outer paper width. Its column gap is
therefore exactly twice the side padding: usable width + gap advances each
successive column by one full outer paper width, the same divisor used when
turning fragment X-coordinates into page indices. A zero gap under-counts
later pages as the error accumulates across columns.

Each break's *live* Y-position is then found by matching the clone's elements
back to the same elements in the real, visible `.page` (same DOM, same order,
just walked in parallel) and reading the real gap between the last element of
one page and the first of the next. Because that gap is real inter-block
whitespace (section/role spacing already in the design), the seam — a
hairline rule, two soft shadow fades suggesting a lifted sheet edge, and a
small mono "Page N" folio echoing the print footer's own typography — never
overlaps a glyph. The one case that can't guarantee a clean gap (a long
unbroken paragraph, e.g. cover-letter body, splitting mid-block) falls back to
a thin dashed marker instead of a shadowed gap, rather than mis-drawing a full
seam through text.

The overlay is a `pointer-events: none`, `aria-hidden` sibling of `.page`, so
clicking, selecting, and editing inside the résumé/cover letter are completely
unaffected, and it never enters `.page`'s `innerHTML` — so it can never be
captured by the `contenteditable` autosave, never gets duplicated into
localStorage, and never touches ATS/reading-order semantics.

## Print/PDF verification

- No selector inside `resume.css` / `cover-letter.css` / `colors_and_type.css`
  was touched. `@page letter/a4/letter-compact/a4-compact`, the named-page
  selection rules, and the running footer are byte-identical to before.
- The only new `@media print` rules *add* `display: none` /
  `display: contents` to the two new chrome elements; they don't override any
  existing print declaration for `.page`, `body`, or `html`.
- `.ic-page-guides` and its seam/folio children never appear inside
  `main.page`, so there is nothing for the print pipeline to strip — the
  generated PDF's content stream is unaffected by construction, not by a
  print-time filter that could someday miss a case.
- The measurement clone is created, measured, and removed synchronously,
  fully detached from the document that Chrome's print pipeline reads at
  export time.
- See `pagination-contract-check.js`, in particular the two print-media tests,
  for an automated check of all of the above against the generated HTML.

## Tests

The wired `scripts/electron-smoke.js` suite exercises generated application
HTML in the app's real Chromium runtime, including a 26-block fixture that
must report all six shadow pages. Run it from the repository root with
`npm run test:e2e`.

`pagination-contract-check.js` is a narrower, unwired Playwright suite against
`Application-paginated-example.html`: structural containment
(guides never inside `main.page`, exactly one `main.page` per panel),
inertness (`aria-hidden`, `pointer-events: none`), recompute on tab switch /
edit / resize / variant-attribute change without throwing, and the print-media
assertions above. If `@playwright/test` and its browser are installed, run it
from the design-system root with:

```sh
npx playwright test handoff/pagination-contract-check.js
```

## Known approximation

Guides are computed by measurement, not by re-running the real print engine —
they land extremely close to Chromium's actual page breaks (same
fragmentation rules) but are not guaranteed byte-identical to the exported
PDF's break points in every edge case (e.g. sub-pixel rounding, a paragraph
that breaks mid-line). That's an acceptable, documented gap for a screen-only
orientation aid; the print/PDF path is the source of truth for where pages
actually end, and this patch never changes it.
