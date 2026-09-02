/**
 * Local render → page-count pipeline for the résumé/cover-letter documents
 * `resumeHtml.js` builds. Two exports:
 *
 *   renderPdf(html, { signal })  — hidden BrowserWindow → PDF bytes + page count
 *                                 + measured page-text extent
 *   applyDualPdf(bytes)          — OCG cream-layer post-process (dual-pdf variant only)
 *
 * jobApplication.js is the only caller — it drives the render → page-count →
 * fit loop (SKILL.md §5's "compact-density algorithm") around `renderPdf`,
 * deciding when to re-render with `data-density="compact"` or ask the model
 * for a length revision. This module itself makes no fit decisions; it only
 * renders whatever HTML it's given, once, and reports back what came out.
 *
 * Why `webContents.printToPDF` and not puppeteer-core/playwright (both are
 * already an `npm i` away in this repo's package.json): Electron ships its
 * own Chromium, so a hidden BrowserWindow gets print-to-PDF for free without
 * managing a separate Chromium — puppeteer-core/playwright would mean
 * downloading/managing a SEPARATE Chromium (or pointing at system Chrome —
 * exactly the CDP-fingerprint problem the marketplace scrapers fight
 * elsewhere in this app) for a trusted, app-authored HTML document. Not worth
 * it here.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import electronPkg from 'electron';
// Namespace import as well as the named one: `PDFLib` is handed wholesale to
// the design system's UMD module (see getDualModePdf below), which expects the
// same shape the CDN build exposes as a global.
import * as PDFLib from 'pdf-lib';
import { PDFDocument } from 'pdf-lib';
import { logger } from '../logger.js';
import { ATS_SAFE_PDF_FONT_TOKENS, getDesignSystemDir, webFontFacesReadyExpression } from './resumeHtml.js';

const { BrowserWindow } = electronPkg;

// Hard ceiling on one render (load + fonts-ready + printToPDF). Without this,
// a printToPDF call that never resolves — a hung page, a Chromium print
// pipeline that never reaches "ready" — would hang the fit loop and, by
// extension, the user's Generate click indefinitely. Same failure shape
// REFRESH_TIMEOUT_MS guards against in browserViewMonitor.js; not imported
// from there — that timeout is tuned for a LIVE network page reload, this one
// for a local document with a bounded font-readiness dependency, so the values
// (and what a timeout here actually diagnoses) don't share enough to be worth
// coupling.
const RENDER_TIMEOUT_MS = 20_000;

// Chromium converts downloaded web fonts to Type 3 glyph programs in printed
// PDFs on macOS. They look correct, but PDFKit and ATS-style extractors can
// split ordinary words into reordered single glyphs. Keep the editable HTML's
// editorial web typography, then switch only the isolated PDF render to common
// system fonts that Chromium embeds with usable Unicode maps.
const ATS_SAFE_PDF_FONT_BY_WEB_FAMILY = Object.freeze({
  'source serif 4': ATS_SAFE_PDF_FONT_TOKENS['--ff-display'],
  inter: ATS_SAFE_PDF_FONT_TOKENS['--ff-body'],
  'ibm plex mono': ATS_SAFE_PDF_FONT_TOKENS['--ff-mono'],
});

// `@page` margin boxes cannot inherit the root custom properties in Chromium.
// The design system deliberately spells the running-footer family out in its
// four named-page rules, so changing --ff-mono alone leaves those boxes on
// IBM Plex Mono. Add a later rule for each named page in the disposable PDF
// document so *all* printed text uses the ATS-safe family before font
// readiness is assessed. Keep this here instead of changing the design-system
// literals: the editable document should retain its editorial typography.
const ATS_SAFE_PDF_PAGE_FONT_OVERRIDE_CSS = [
  'letter',
  'a4',
  'letter-compact',
  'a4-compact',
].map((pageName) => `@page ${pageName} { @bottom-right { font-family: ${ATS_SAFE_PDF_FONT_TOKENS['--ff-mono']}; } }`).join('\n');

export function atsSafePdfFontExpression() {
  return `(function () {
    var root = document.documentElement;
    ${Object.entries(ATS_SAFE_PDF_FONT_TOKENS)
      .map(([property, value]) => `root.style.setProperty(${JSON.stringify(property)}, ${JSON.stringify(value)});`)
      .join(' ')}
    var safeFamilyByWebFamily = ${JSON.stringify(ATS_SAFE_PDF_FONT_BY_WEB_FAMILY)};
    var firstFamily = function (value) {
      return (String(value || '').split(',')[0] || '').trim().replace(/^["']|["']$/g, '').toLowerCase();
    };
    Array.prototype.forEach.call(document.querySelectorAll('*'), function (element) {
      var replacement = safeFamilyByWebFamily[firstFamily(getComputedStyle(element).fontFamily)];
      if (replacement) element.style.setProperty('font-family', replacement);
    });
    var override = document.getElementById('ic-ats-safe-pdf-page-fonts');
    if (!override) {
      override = document.createElement('style');
      override.id = 'ic-ats-safe-pdf-page-fonts';
      (document.head || root).appendChild(override);
    }
    override.textContent = ${JSON.stringify(ATS_SAFE_PDF_PAGE_FONT_OVERRIDE_CSS)};
    return true;
  })()`;
}

/** Detect font programs that render visually but routinely break text extraction. */
export async function pdfContainsType3Fonts(bytes) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const type3 = PDFLib.PDFName.of('Type3');
  const subtype = PDFLib.PDFName.of('Subtype');
  return pdf.context.enumerateIndirectObjects().some(([, object]) =>
    object instanceof PDFLib.PDFDict && object.get(subtype) === type3);
}

// The screen-preview `.page` box has a fixed minimum paper height, but it
// expands when its contents overflow. Fit telemetry must compare text against
// the fixed type area, never against that expanded box.
export function fixedPageTypeAreaHeight(minPageHeightPx, paddingTopPx, paddingBottomPx) {
  const minPageHeight = Number(minPageHeightPx);
  const paddingTop = Number(paddingTopPx);
  const paddingBottom = Number(paddingBottomPx);
  if (!Number.isFinite(minPageHeight) || !Number.isFinite(paddingTop) || !Number.isFinite(paddingBottom)) return null;
  const height = minPageHeight - paddingTop - paddingBottom;
  return height > 0 ? height : null;
}

// Keep the browser-side probe self-contained and assemble it without a
// JavaScript template literal. The previous template contained a backtick in
// an inline comment; that closed the template early and made Chromium try to
// invoke `.page` as a function before either document could be measured.
export function pageTextMeasurementExpression() {
  return [
    '(function () {',
    '  try {',
    // A combined workspace keeps both documents' <main.page> in the DOM at
    // once, with the inactive one `hidden`. Falling back to the bare
    // selector keeps this working for a standalone document, which has no
    // [data-ic-document-panel] wrapper at all.
    "    var page = document.querySelector('[data-ic-document-panel]:not([hidden]) main.page') || document.querySelector('main.page');",
    '    if (!page) return null;',
    '    var pageStyle = getComputedStyle(page);',
    "    var minPageHeight = parseFloat(pageStyle.minHeight || '0');",
    "    var paddingTop = parseFloat(pageStyle.paddingTop || '0');",
    "    var paddingBottom = parseFloat(pageStyle.paddingBottom || '0');",
    '    var typeAreaHeight = minPageHeight - paddingTop - paddingBottom;',
    '    if (!Number.isFinite(typeAreaHeight) || typeAreaHeight <= 0) return null;',
    '    var top = Infinity;',
    '    var bottom = -Infinity;',
    '    var walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT, {',
    '      acceptNode: function (node) {',
    "        return String(node.nodeValue || '').trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;",
    '      }',
    '    });',
    '    var node;',
    '    while ((node = walker.nextNode())) {',
    '      var range = document.createRange();',
    '      range.selectNodeContents(node);',
    '      Array.prototype.forEach.call(range.getClientRects(), function (rect) {',
    '        if (!rect.height) return;',
    '        top = Math.min(top, rect.top);',
    '        bottom = Math.max(bottom, rect.bottom);',
    '      });',
    '    }',
    '    if (!Number.isFinite(top) || !Number.isFinite(bottom)) return null;',
    '    return { contentHeightPx: bottom - top, typeAreaHeightPx: typeAreaHeight };',
    '  } catch (_) {',
    '    return null;',
    '  }',
    '})()',
  ].join('\n');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
}

function abortError() {
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

// Destroying a BrowserWindow normally makes the in-flight Electron operation
// reject, but that is not guaranteed for every load/print state. Race each
// wait with AbortSignal too, so cancellation never waits for the render timeout.
function withTimeout(promise, ms, label, signal) {
  if (signal?.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, abortError());

    timer = setTimeout(() => finish(reject, new Error(`${label} timed out after ${ms}ms`)), ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      value => finish(resolve, value),
      error => finish(reject, error),
    );
  });
}

/**
 * Render one single-file HTML document to PDF bytes + page count. Its CSS and
 * scripts and design-system typefaces are inline.
 *
 * Loads from a TEMP FILE, not a `data:` URL. The résumé/cover-letter HTML
 * already inlines the whole design-system CSS (colors_and_type.css +
 * resume.css, tens of KB) plus the model's markup; base64-encoding that into
 * a data: URL bloats it ~33% further and risks the length ceilings some
 * `loadURL` paths hit well under Chromium's own (very large) limit. A temp
 * file has no such ceiling — that's what `win.loadFile()` is for. The
 * tradeoff is a disk write + cleanup per render attempt (the fit loop in
 * jobApplication.js can call this up to a handful of times per Generate
 * click) — negligible next to the LLM calls already on that path.
 *
 * @param {string} html
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {'resume'|'cover'} [opts.document] Which panel to print from a
 * combined application workspace. The generated tabs are switched inside the
 * isolated render window before font readiness/printing is measured. Omit for
 * a standalone résumé or cover-letter document.
 * @returns {Promise<{bytes: Uint8Array, pageCount: number, layout: {contentHeightPx: number, typeAreaHeightPx: number}|null}>}
 */
export async function renderPdf(html, { signal, document = null } = {}) {
  throwIfAborted(signal);

  let tempDir = null;
  let win = null;
  // Force-destroy immediately on abort rather than waiting for the current
  // await to reject on its own — a cancelled generation must not leave a
  // hidden BrowserWindow alive for the duration of whatever step happened to
  // be in flight (see the finally block below for why a leaked one matters).
  const onAbort = () => { if (win && !win.isDestroyed()) win.destroy(); };

  try {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jobapp-render-'));
    const tempPath = path.join(tempDir, `${crypto.randomUUID()}.html`);
    await fs.promises.writeFile(tempPath, String(html || ''), { encoding: 'utf8', mode: 0o600 });
    throwIfAborted(signal);

    win = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        // No preload — this is our own trusted, self-authored HTML (built by
        // resumeHtml.js from the model's markup + the design system's CSS),
        // not a page we need to script the way browserViewMonitor.js does
        // for hostile third-party sites.
      },
    });
    signal?.addEventListener('abort', onAbort);
    throwIfAborted(signal);

    const wc = win.webContents;

    // Generated application HTML contains model-authored markup and runs only
    // so its own layout/tab scripts can prepare the print. Keep that content
    // inside this disposable file: it must not navigate the hidden top-level
    // window or launch an OS browser through target=_blank/window.open.
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event) => event.preventDefault());
    wc.on('will-redirect', (event) => event.preventDefault());

    // did-finish-load AND document.fonts.ready — the design system's own
    // font-load check (resumeHtml.js's injected `ic-font-warning` banner)
    // exists precisely because fonts loading late RESIZES the page (fallback
    // metrics can differ across font families), which
    // changes what fits on a page. Printing before fonts settle would size —
    // and page-count — the résumé against fallback-font metrics, giving a
    // pass/fail verdict that doesn't match what the user's own screen (or a
    // later, fully-loaded print) would show.
    await withTimeout(new Promise((resolve, reject) => {
      wc.once('did-finish-load', resolve);
      wc.once('did-fail-load', (_e, code, desc) => reject(new Error(`did-fail-load ${code}: ${desc || 'unknown'}`)));
      win.loadFile(tempPath).catch(reject);
    }), RENDER_TIMEOUT_MS, 'renderPdf: did-finish-load', signal);
    throwIfAborted(signal);

    if (document === 'cover' || document === 'resume') {
      // Application.html keeps both documents in one single-file editor.
      // Its tab script is synchronous, so selecting cover before the font
      // check guarantees printToPDF sees the cover panel rather than hidden
      // résumé content. No caller-controlled JavaScript is interpolated here.
      const tabId = document === 'cover' ? 'ic-cover-tab' : 'ic-resume-tab';
      const label = document === 'cover' ? 'cover letter' : 'résumé';
      await withTimeout(
        wc.executeJavaScript(`(function () { var tab = document.getElementById(${JSON.stringify(tabId)}); if (!tab) throw new Error(${JSON.stringify(`${label} panel is unavailable.`)}); tab.click(); })()`),
        RENDER_TIMEOUT_MS,
        `renderPdf: select ${label}`,
        signal,
      );
      throwIfAborted(signal);
    }

    await withTimeout(
      wc.executeJavaScript(atsSafePdfFontExpression()),
      RENDER_TIMEOUT_MS,
      'renderPdf: apply ATS-safe PDF typography',
      signal,
    );
    throwIfAborted(signal);

    // `document.fonts.ready` is NOT a success signal — per spec it resolves
    // when font loading FINISHES, including when a requested face is
    // unavailable. The isolated render has already switched the document to
    // ATS-safe system families, but `ready` can still settle with a different
    // fallback metric. Page count measured there is measured against the wrong
    // typography — which would
    // drive the compact-density decision (and potentially an LLM revision that
    // cuts real content) off a number the user will never see.
    //
    // So: force the document's computed face set to load before `ready`, then
    // walk actual document text and verify its exact
    // display/body/mono face+weight set. Application.html keeps the cover
    // panel hidden while the résumé is printed; `document.fonts.ready` does
    // not necessarily fetch a face used exclusively in display:none content.
    // Without these explicit loads, the shared all-panel predicate could
    // report a valid hidden cover face as missing and incorrectly withhold a
    // perfectly valid baseline résumé PDF. Loading every computed face up front
    // also ensures a later Sync cannot inherit an unchecked fallback. The
    // detailed predicate remains the single source of truth for which faces the
    // emitted document actually requires.
    const fontReadiness = await withTimeout(
      wc.executeJavaScript(`(async function () {
        var initial = ${webFontFacesReadyExpression({ details: true })};
        var faceDescriptors = Array.isArray(initial.requiredFaces) ? initial.requiredFaces : [];
        await Promise.all(faceDescriptors.map(function (descriptor) {
          return document.fonts.load(descriptor, 'A').catch(function () { return []; });
        }));
        await document.fonts.ready;
        return ${webFontFacesReadyExpression({ details: true })};
      })()`),
      RENDER_TIMEOUT_MS,
      'renderPdf: document.fonts.ready',
      signal,
    );
    const fontsLoaded = fontReadiness?.loaded !== false;
    const missingFontFaces = Array.isArray(fontReadiness?.missingFaces)
      ? fontReadiness.missingFaces.filter(Boolean).slice(0, 12)
      : [];
    throwIfAborted(signal);

    // STYLE.md §11.5 makes short-letter centring a measure-then-set decision.
    // Measure only text inside the printable page, using line rectangles rather
    // than element boxes so collapsed margins and the optical edge trims do not
    // distort the result. This is intentionally collected before printToPDF:
    // the cover's screen page has the same token-driven type area, while print
    // drops its screen box and cannot report the available slack directly.
    const layout = await withTimeout(
      wc.executeJavaScript(pageTextMeasurementExpression()),
      RENDER_TIMEOUT_MS,
      'renderPdf: measure page text',
      signal,
    );
    throwIfAborted(signal);

    // printBackground + preferCSSPageSize are both REQUIRED (SKILL.md §5,
    // step 5): printBackground so the dual-pdf variant's background rule (and
    // any accent fills) actually render into the content stream at all;
    // preferCSSPageSize so the design system's CSS-named pages (`@page
    // letter` / `@page a4`, switched by `data-page`) size the PDF instead of
    // whatever default page size Electron would otherwise pick.
    const pdfBuffer = await withTimeout(
      wc.printToPDF({ printBackground: true, preferCSSPageSize: true }),
      RENDER_TIMEOUT_MS,
      'renderPdf: printToPDF',
      signal,
    );
    throwIfAborted(signal);

    // pdfBuffer is a Node Buffer (a Uint8Array subclass) — fine to hand back
    // as-is; pdf-lib and fs.writeFile both accept it directly.
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    throwIfAborted(signal);
    const pageCount = pdfDoc.getPageCount();
    if (await pdfContainsType3Fonts(pdfBuffer)) {
      throw new Error('renderPdf produced Type 3 fonts that are not safe for ATS/PDF text extraction.');
    }
    if (!fontsLoaded) {
      logger.warn(
        '[ResumeRender] Required PDF fonts did not load in the render window. '
        + `Missing face(s): ${missingFontFaces.join(', ') || 'unavailable face detail'}. `
        + `Page count ${pageCount} was measured against fallback typefaces and does NOT reflect the real document — the fit loop will not act on it.`,
      );
    }
    return { bytes: pdfBuffer, pageCount, fontsLoaded, layout };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // A leaked hidden BrowserWindow keeps the whole Electron process alive
    // (it only quits once every window is gone) with NO visible symptom — a
    // show:false window has no taskbar/dock entry, so this failure mode looks
    // like "the app just never exits" with no obvious cause. Always destroy,
    // on every exit path (success, thrown error, or abort).
    if (win && !win.isDestroyed()) win.destroy();
    if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Dual-mode (OCG cream layer) post-process
// ---------------------------------------------------------------------------

// Job Application Design System/build/dual-mode-pdf.js is a UMD module owned by the
// design system (read-only from this repo's side, same as the CSS/HTML files
// — see resumeHtml.js's getDesignSystemDir() doc-comment). It isn't published
// to npm, so a static ESM `import` can't reach it, and it's resolved through
// getDesignSystemDir() rather than a path relative to this file for the same
// reason resumeHtml.js resolves the CSS that way: in a packaged app it lives
// in Contents/Resources, not next to this module.
//
// ── Why we evaluate it instead of `require()`-ing it ──────────────────────
// SKILL.md §6's Node sample is a bare `require('./build/dual-mode-pdf.js')`,
// and that is exactly what does NOT work in a packaged build. The UMD's Node
// branch runs `require('pdf-lib')` from ITS OWN location — and the design
// system ships via electron-builder `extraResources` to
// `Contents/Resources/Job Application Design System/`, a SIBLING of `app.asar`, while
// `pdf-lib` lives inside `app.asar/node_modules`. Node's resolver only walks
// UPWARD through ancestor directories, and `app.asar/node_modules` is never an
// ancestor of `Job Application Design System/build/`, so the inner require throws
// MODULE_NOT_FOUND. (Confirmed against a real packaged build: it appears to
// work from a dev checkout only because the repo's own root node_modules
// happens to sit in the ancestor chain — a coincidence that vanishes the
// moment the .app is moved to /Applications.) The failure is silent-ish:
// applyDualPdf throws, the caller degrades to the flat PDF, and dual-mode
// output would simply never exist in production.
//
// So take the UMD's OTHER branch instead. Evaluated in THIS realm (not a `vm`
// context) on purpose, for two reasons: the module needs Node globals the
// design system's browser branch assumes are present (`TextEncoder`), and a
// separate realm would give it a different `Uint8Array` identity than the
// `pdf-lib` instance we hand it, which is the classic cross-realm
// `instanceof` trap. Handing in our OWN already-imported pdf-lib also pins the
// exact version this app ships rather than whatever the resolver might find.
//
// Evaluating a file is the same trust level as requiring it — this is a
// vendored, read-only asset at a path getDesignSystemDir() validated, never
// user input.
let _dualModePdf = null;
function getDualModePdf() {
  if (_dualModePdf) return _dualModePdf;
  const modulePath = path.join(getDesignSystemDir(), 'build', 'dual-mode-pdf.js');
  const src = fs.readFileSync(modulePath, 'utf8');
  // The UMD picks its root as `typeof self !== 'undefined' ? self : this`, then
  // does `root.DualModePdf = factory(root.PDFLib)` — so seed `self` with our
  // pdf-lib and read the module back off it.
  const root = { PDFLib };
  _dualModePdf = new Function('self', `${src}\n;return self.DualModePdf;`)(root);
  if (typeof _dualModePdf?.addOcgBackground !== 'function') {
    _dualModePdf = null;
    throw new Error(`dual-mode-pdf.js at ${modulePath} did not export addOcgBackground — the design system's build/ folder may be stale or partially copied.`);
  }
  return _dualModePdf;
}

/**
 * Post-process PDF bytes with the design system's view-cream/print-white OCG
 * layer. Caller's responsibility to only call this for the `dual-pdf` variant
 * (resumeHtml.js's `isDualMode()`) — SKILL.md §5 step 6 is explicit that
 * running this on an `ink-only` PDF produces an incorrect dual state (a cream
 * layer over an already-white page). This function does not re-check the
 * variant itself; it has no access to it, only bytes in / bytes out, mirroring
 * `addOcgBackground`'s own pure (bytes → bytes) contract.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
export async function applyDualPdf(bytes) {
  const { addOcgBackground } = getDualModePdf();
  return await addOcgBackground(bytes);
}

/**
 * Return whether a PDF already carries the design system's view-only cream
 * Optional Content Group.  The root HTML variant and this layer are one
 * logical decision; checking only byte hashes can accidentally bless an old
 * dual-mode PDF beside a newly generated ink-only Application.html.
 */
export async function pdfHasDualModeBackground(bytes) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const ocProperties = pdf.catalog.lookup(PDFLib.PDFName.of('OCProperties'));
  if (!(ocProperties instanceof PDFLib.PDFDict)) return false;
  const groups = ocProperties.lookup(PDFLib.PDFName.of('OCGs'));
  if (!(groups instanceof PDFLib.PDFArray)) return false;
  const expectedName = 'Editorial cream background';
  for (let index = 0; index < groups.size(); index += 1) {
    const group = pdf.context.lookup(groups.get(index));
    const name = group instanceof PDFLib.PDFDict
      ? group.lookup(PDFLib.PDFName.of('Name'))
      : null;
    const value = typeof name?.asString === 'function' ? name.asString() : String(name || '');
    if (value === expectedName) return true;
  }
  return false;
}
