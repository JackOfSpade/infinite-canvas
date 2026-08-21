# Manual checks — `build/*-check.html`

These eight files are **browser reference fixtures** and are not wired into
the design-system Node chain. The seven HTML fixtures remain manual. The
host app's pagination behavior does have separate, wired real-Chromium
coverage in `scripts/electron-smoke.js`, including a deterministic six-page
regression; the handoff-specific Playwright suite listed below remains
unwired.

They used to be named `*-test.html`, which implied they ran in the test
chain. They did not, and never have. The `-check` suffix is the honest
name: `npm test` (in `build/`) runs the Node suites; these are the
render truths behind the numbers those suites assert.

| File | What it measures | Run it when |
|------|------------------|-------------|
| `bullet-length-check.html` | Renders worst-case bullet text at the 180/100-character budget across Letter/A4 × default/compact and asserts ≤ 2 wrapped lines. | Any type-scale, margin, or density change — before trusting `annotation-budget-test.js`'s 180. |
| `resume-one-page-check.html` | Utilisation of one measured type area by the shipped `resume.html` (target 0.90–1.00). | After editing the sample résumé or the spacing scale. |
| `cover-letter-one-page-check.html` | Same, for `cover-letter.html`. | After editing the sample letter, its type tokens, or the tail trim. |
| `multi-page-fragmentation-check.html` | Fixture for the **explicit** multi-page override: clean breaks between blocks, running footer on pages 2+. | When touching `@page`, the break-* rules, or the footer margin boxes. |
| `annotation-typography-check.html` | Computed styles of a rendered annotated bullet — one font-size, one colour, no italic. | Alongside `annotation-typography-test.js` when annotation CSS changes. |
| `education-placement-check.html` | The two valid header-subtitle shapes, measured in a real engine. | When the subtitle component changes. |
| `browser-check.html` | `dual-mode-pdf.js` through its **browser** UMD path (`window.PDFLib` → `window.DualModePdf`) — the access path the Node test cannot reach. | Whenever `dual-mode-pdf.js` changes. |
| `../handoff/pagination-contract-check.js` | Narrow Playwright suite for the frozen paginated-preview handoff. The integrated host path is covered separately by `scripts/electron-smoke.js`; this fixture still needs `@playwright/test` plus a browser and is not wired. | When regenerating the frozen handoff snapshot or contract. |

Open the HTML ones directly in Chrome (`file://` is fine — the CSS and
`pdf-lib` load from CDN) and read the PASS/FAIL banner. Each one also
logs `SUMMARY: n passed, n failed` to the console.

**If you want any of them automated**, that is a CI job with a real
browser binary (`actions/setup-node` + `npx playwright install
chromium`) — not a wiring change here. Until that exists, treat the
render numbers as human-verified and dated by whoever last ran them.
